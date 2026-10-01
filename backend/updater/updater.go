// Package updater prüft auf GitHub nach neuen Releases von MapViewer3D, lädt das
// Update-Paket (MapViewer3D-update-Beta.N.zip) herunter, prüft die SHA-256-Summe,
// tauscht die Dateien mit Sicherung aus und stößt einen Neustart an.
//
// Der Viewer nutzt es für Download-Installationen (Update per Klick) und für
// Server (automatisch, -auto-update); der Positions-Agent für sich selbst.
package updater

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	DefaultRepo     = "dev-prophet-code/MapViewer3D"
	DefaultInterval = 6 * time.Hour
	maxZip          = 400 << 20 // Obergrenze für den Download
	maxFile         = 300 << 20 // Obergrenze je entpackter Datei
)

// Op ist ein Austausch: Src (im Staging-Ordner) ersetzt Dest. Ist Dest ein
// Ordner, wird er als Ganzes getauscht.
type Op struct{ Src, Dest string }

// Config beschreibt, was aktualisiert wird.
type Config struct {
	Repo     string        // GitHub-Repo "Besitzer/Name"; Standard DefaultRepo
	Current  string        // laufende Version, z. B. "Beta.12"
	Work     string        // beschreibbarer Ordner auf demselben Laufwerk wie die Ziele (.update darin)
	Auto     bool          // gefundene Updates sofort installieren
	Interval time.Duration // Abstand der Prüfungen
	// Plan legt fest, welche Dateien aus dem entpackten Paket wohin kommen.
	Plan func(stage string) ([]Op, error)
	// Prepare läuft nach dem Entpacken (z. B. Programm aus dem Quelltext bauen).
	Prepare func(ctx context.Context, stage, version string) error
	// SelfTest prüft das neue Programm vor dem Austausch (optional).
	SelfTest func(stage string, ops []Op, version string) error
	// Restart startet das Programm neu; kehrt normalerweise nicht zurück.
	Restart func()
	// APIBase ersetzt https://api.github.com (Tests).
	APIBase string
	Client  *http.Client
}

// Status ist, was die Oberfläche sieht.
type Status struct {
	Current   string    `json:"current"`
	Latest    string    `json:"latest,omitempty"`
	Available bool      `json:"available"`
	CanApply  bool      `json:"canApply"` // das Release enthält ein Update-Paket
	URL       string    `json:"url,omitempty"`
	Notes     string    `json:"notes,omitempty"`
	State     string    `json:"state"` // idle, checking, downloading, installing, restarting, error
	Error     string    `json:"error,omitempty"`
	Auto      bool      `json:"auto"`
	Checked   time.Time `json:"checked,omitzero"`
}

type Updater struct {
	cfg Config

	mu    sync.Mutex
	st    Status
	asset string // Download-URL des Pakets
	sum   string // Download-URL der Summe
	busy  bool
}

func New(cfg Config) *Updater {
	if cfg.Repo == "" {
		cfg.Repo = DefaultRepo
	}
	if cfg.Interval <= 0 {
		cfg.Interval = DefaultInterval
	}
	if cfg.APIBase == "" {
		cfg.APIBase = "https://api.github.com"
	}
	if cfg.Client == nil {
		cfg.Client = &http.Client{Timeout: 10 * time.Minute}
	}
	return &Updater{cfg: cfg, st: Status{Current: cfg.Current, State: "idle", Auto: cfg.Auto}}
}

// Status liefert den aktuellen Stand.
func (u *Updater) Status() Status {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.st
}

// Run prüft beim Start (nach kurzer Pause) und dann regelmäßig; mit Auto wird installiert.
func (u *Updater) Run(ctx context.Context) {
	t := time.NewTimer(90 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		if err := u.Check(ctx); err != nil {
			log.Printf("Update-Prüfung: %v", err)
		} else if st := u.Status(); st.Available && st.CanApply && u.cfg.Auto {
			log.Printf("Update %s gefunden, wird installiert (automatisch)", st.Latest)
			if err := u.Install(ctx); err != nil {
				log.Printf("Update fehlgeschlagen: %v", err)
			}
		}
		t.Reset(u.cfg.Interval)
	}
}

type release struct {
	Tag        string `json:"tag_name"`
	Name       string `json:"name"`
	Draft      bool   `json:"draft"`
	HTMLURL    string `json:"html_url"`
	Body       string `json:"body"`
	Prerelease bool   `json:"prerelease"`
	Assets     []struct {
		Name string `json:"name"`
		URL  string `json:"browser_download_url"`
	} `json:"assets"`
}

var tagRe = regexp.MustCompile(`(?i)^beta\.(\d+)$`)

// Number liest die Nummer aus "Beta.12" / "beta.12".
func Number(v string) (int, bool) {
	m := tagRe.FindStringSubmatch(strings.TrimSpace(v))
	if m == nil {
		return 0, false
	}
	n, err := strconv.Atoi(m[1])
	return n, err == nil
}

// Check fragt GitHub nach dem neuesten Release (nur Tags beta.N).
func (u *Updater) Check(ctx context.Context) error {
	u.setState("checking", "")
	rel, err := u.latest(ctx)
	if err != nil {
		u.setState("error", err.Error())
		return err
	}
	cur, curOK := Number(u.cfg.Current)
	n, _ := Number(rel.Tag)
	u.mu.Lock()
	defer u.mu.Unlock()
	u.st.Checked = time.Now()
	u.st.State, u.st.Error = "idle", ""
	u.st.Latest = "Beta." + strconv.Itoa(n)
	u.st.Available = curOK && n > cur
	u.st.URL = rel.HTMLURL
	u.st.Notes = clip(rel.Body, 700)
	u.asset, u.sum = "", ""
	want := "MapViewer3D-update-" + u.st.Latest + ".zip"
	prefix := "https://github.com/" + u.cfg.Repo + "/releases/download/"
	for _, a := range rel.Assets {
		if !strings.HasPrefix(a.URL, prefix) {
			continue
		}
		switch a.Name {
		case want:
			u.asset = a.URL
		case want + ".sha256":
			u.sum = a.URL
		}
	}
	u.st.CanApply = u.asset != "" && u.sum != ""
	return nil
}

func (u *Updater) latest(ctx context.Context) (release, error) {
	req, _ := http.NewRequestWithContext(ctx, "GET", u.cfg.APIBase+"/repos/"+u.cfg.Repo+"/releases?per_page=30", nil)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "MapViewer3D-updater")
	resp, err := u.cfg.Client.Do(req)
	if err != nil {
		return release{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return release{}, fmt.Errorf("GitHub antwortet %s", resp.Status)
	}
	var rels []release
	if err := json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(&rels); err != nil {
		return release{}, err
	}
	best, bestN := release{}, -1
	for _, r := range rels {
		if r.Draft {
			continue
		}
		if n, ok := Number(r.Tag); ok && n > bestN {
			best, bestN = r, n
		}
	}
	if bestN < 0 {
		return release{}, errors.New("kein Release beta.N gefunden")
	}
	return best, nil
}

func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

func (u *Updater) setState(state, errMsg string) {
	u.mu.Lock()
	u.st.State, u.st.Error = state, errMsg
	u.mu.Unlock()
}

// Install lädt und installiert das gefundene Update und startet neu. Nur ein Lauf gleichzeitig.
func (u *Updater) Install(ctx context.Context) (err error) {
	u.mu.Lock()
	if u.busy {
		u.mu.Unlock()
		return errors.New("Update läuft bereits")
	}
	if !u.st.Available || !u.st.CanApply {
		u.mu.Unlock()
		return errors.New("kein installierbares Update")
	}
	u.busy = true
	asset, sumURL, version := u.asset, u.sum, u.st.Latest
	u.mu.Unlock()
	defer func() {
		u.mu.Lock()
		u.busy = false
		u.mu.Unlock()
		if err != nil {
			u.setState("error", err.Error())
		}
	}()

	work := filepath.Join(u.cfg.Work, ".update")
	if err := os.MkdirAll(work, 0o755); err != nil {
		return err
	}
	stage := filepath.Join(work, "stage")
	os.RemoveAll(stage)
	defer os.RemoveAll(stage)
	zipPath := filepath.Join(work, "update.zip")
	defer os.Remove(zipPath)

	u.setState("downloading", "")
	want, err := u.fetchSum(ctx, sumURL)
	if err != nil {
		return fmt.Errorf("Prüfsumme: %w", err)
	}
	got, err := u.download(ctx, asset, zipPath)
	if err != nil {
		return fmt.Errorf("Download: %w", err)
	}
	if got != want {
		return fmt.Errorf("SHA-256 stimmt nicht (erwartet %s…, erhalten %s…)", want[:12], got[:12])
	}
	u.setState("installing", "")
	if err := Unzip(zipPath, stage); err != nil {
		return fmt.Errorf("Entpacken: %w", err)
	}
	if u.cfg.Prepare != nil {
		if err := u.cfg.Prepare(ctx, stage, version); err != nil {
			return fmt.Errorf("Vorbereiten: %w", err)
		}
	}
	ops, err := u.cfg.Plan(stage)
	if err != nil {
		return err
	}
	if len(ops) == 0 {
		return errors.New("das Paket enthält nichts zum Aktualisieren")
	}
	if u.cfg.SelfTest != nil {
		if err := u.cfg.SelfTest(stage, ops, version); err != nil {
			return fmt.Errorf("Selbsttest des neuen Programms: %w", err)
		}
	}
	backup := filepath.Join(work, "backup-"+u.cfg.Current)
	if err := Apply(ops, backup); err != nil {
		return err
	}
	pruneBackups(work, 2)
	log.Printf("Update %s installiert (Sicherung: %s), Neustart", version, backup)
	u.setState("restarting", "")
	// Aufräumen vor dem Neustart: danach läuft dieser Code nicht mehr zu Ende
	os.RemoveAll(stage)
	os.Remove(zipPath)
	if u.cfg.Restart != nil {
		u.cfg.Restart()
	}
	return nil
}

func (u *Updater) fetchSum(ctx context.Context, url string) (string, error) {
	req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
	req.Header.Set("User-Agent", "MapViewer3D-updater")
	resp, err := u.cfg.Client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", errors.New(resp.Status)
	}
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	f := strings.Fields(string(b))
	if len(f) == 0 || len(f[0]) != 64 {
		return "", errors.New("ungültiges Format")
	}
	return strings.ToLower(f[0]), nil
}

func (u *Updater) download(ctx context.Context, url, dest string) (string, error) {
	req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
	req.Header.Set("User-Agent", "MapViewer3D-updater")
	resp, err := u.cfg.Client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", errors.New(resp.Status)
	}
	f, err := os.Create(dest)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, h), io.LimitReader(resp.Body, maxZip+1))
	if err != nil {
		return "", err
	}
	if n > maxZip {
		return "", errors.New("Paket zu groß")
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// Unzip entpackt nach dest. Ein gemeinsamer oberster Ordner (MapViewer3D/) entfällt.
// Pfade, die aus dest ausbrechen würden, und Links werden abgelehnt.
func Unzip(src, dest string) error {
	zr, err := zip.OpenReader(src)
	if err != nil {
		return err
	}
	defer zr.Close()
	top := commonTop(zr.File)
	for _, f := range zr.File {
		name := strings.TrimPrefix(filepath.ToSlash(f.Name), top)
		if name == "" {
			continue
		}
		target := filepath.Join(dest, filepath.FromSlash(name))
		if rel, err := filepath.Rel(dest, target); err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(name) {
			return fmt.Errorf("unzulässiger Pfad im Paket: %q", f.Name)
		}
		if f.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("Link im Paket: %q", f.Name)
		}
		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
			continue
		}
		if f.UncompressedSize64 > maxFile {
			return fmt.Errorf("Datei zu groß: %q", f.Name)
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		if err := extract(f, target); err != nil {
			return err
		}
	}
	return nil
}

func extract(f *zip.File, target string) error {
	rc, err := f.Open()
	if err != nil {
		return err
	}
	defer rc.Close()
	mode := f.Mode().Perm()
	if mode == 0 {
		mode = 0o644
	}
	out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, io.LimitReader(rc, maxFile+1)); err != nil {
		out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	return os.Chmod(target, mode)
}

// commonTop liefert "Ordner/", wenn alle Einträge darin liegen, sonst "".
func commonTop(files []*zip.File) string {
	top := ""
	for _, f := range files {
		name := filepath.ToSlash(f.Name)
		i := strings.Index(name, "/")
		if i < 0 {
			return ""
		}
		t := name[:i+1]
		if top == "" {
			top = t
		} else if top != t {
			return ""
		}
	}
	return top
}

// Apply tauscht die Ziele aus. Das Alte wandert in backup; schlägt etwas fehl,
// wird alles Getauschte zurückgesetzt. Eine laufende Datei darf umbenannt werden
// (auch unter Windows), deshalb wird nie darüberkopiert.
func Apply(ops []Op, backup string) error {
	if err := os.MkdirAll(backup, 0o755); err != nil {
		return err
	}
	type done struct{ dest, saved string }
	var applied []done
	rollback := func() {
		for i := len(applied) - 1; i >= 0; i-- {
			d := applied[i]
			os.RemoveAll(d.dest)
			if d.saved != "" {
				os.Rename(d.saved, d.dest)
			}
		}
	}
	for i, op := range ops {
		saved := ""
		if _, err := os.Lstat(op.Dest); err == nil {
			saved = filepath.Join(backup, fmt.Sprintf("%02d-%s", i, filepath.Base(op.Dest)))
			os.RemoveAll(saved)
			if err := os.Rename(op.Dest, saved); err != nil {
				rollback()
				return fmt.Errorf("%s sichern: %w", op.Dest, err)
			}
		}
		rerr := os.MkdirAll(filepath.Dir(op.Dest), 0o755)
		if rerr == nil {
			rerr = os.Rename(op.Src, op.Dest)
		}
		if rerr != nil {
			if saved != "" {
				os.Rename(saved, op.Dest)
			}
			rollback()
			return fmt.Errorf("%s ersetzen: %w", op.Dest, rerr)
		}
		applied = append(applied, done{op.Dest, saved})
	}
	return nil
}

// pruneBackups behält nur die jüngsten n Sicherungen.
func pruneBackups(work string, n int) {
	ents, _ := os.ReadDir(work)
	var olds []os.DirEntry
	for _, e := range ents {
		if e.IsDir() && strings.HasPrefix(e.Name(), "backup-") {
			olds = append(olds, e)
		}
	}
	for len(olds) > n {
		oldest := 0
		var ot time.Time
		for i, e := range olds {
			if fi, err := e.Info(); err == nil && (i == 0 || fi.ModTime().Before(ot)) {
				oldest, ot = i, fi.ModTime()
			}
		}
		os.RemoveAll(filepath.Join(work, olds[oldest].Name()))
		olds = append(olds[:oldest], olds[oldest+1:]...)
	}
}
