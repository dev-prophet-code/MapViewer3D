package server

import (
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// ---------- Kartensymbole ----------
//
//	GET /api/icons/<datei>   Markerbild der Console (/images/maps/<datei>)
//
// Die Symbole sind dieselben wie auf der 2D-Live-Karte der Console. Sie werden
// nicht mitgeliefert, sondern beim ersten Abruf vom eingetragenen Server geholt
// und unter state/icons zwischengespeichert. Fehlt ein Bild, zeichnet die
// Oberfläche einen farbigen Punkt.

var iconFile = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}\.(webp|png)$`)

// iconClient lädt Symbole der Console (mit der Zertifikatsprüfung aus consoletls.go).
var iconClient = newConsoleClient(15 * time.Second)

func (s *Server) iconsDir() string { return filepath.Join(s.stateDir, "icons") }

func (s *Server) icon(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("file")
	if !iconFile.MatchString(name) {
		http.NotFound(w, r)
		return
	}
	file := filepath.Join(s.iconsDir(), name)
	if _, err := os.Stat(file); err != nil {
		if err := s.fetchIcon(name, file); err != nil {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
	}
	w.Header().Set("Cache-Control", "public, max-age=86400")
	http.ServeFile(w, r, file)
}

// fetchIcon lädt ein Symbol von der Console. Fehlversuche werden eine Weile
// gemerkt, damit ein fehlendes Bild die Console nicht bei jedem Aufruf trifft.
func (s *Server) fetchIcon(name, file string) error {
	if until, ok := s.iconMisses.Load(name); ok && time.Now().Before(until.(time.Time)) {
		return errIconMissing
	}
	lp := s.lp()
	if lp == nil {
		return errIconMissing
	}
	miss := func(err error) error {
		s.iconMisses.Store(name, time.Now().Add(10*time.Minute))
		return err
	}
	// Die Bilder sind öffentliche Dateien der Console-Oberfläche; der Token wird nicht mitgeschickt.
	resp, err := iconClient.Get(lp.cfg.APIBase + "/images/maps/" + name)
	if err != nil {
		log.Printf("Symbol %s: %v", name, err)
		return miss(errIconMissing)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return miss(errIconMissing)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	// Die Console meldet die Bilder teils als application/octet-stream; maßgeblich ist der Inhalt.
	if err != nil || !strings.HasPrefix(http.DetectContentType(body), "image/") {
		return miss(errIconMissing)
	}
	if err := os.MkdirAll(s.iconsDir(), 0o755); err != nil {
		return err
	}
	tmp := file + ".tmp"
	if err := os.WriteFile(tmp, body, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, file)
}

var errIconMissing = errors.New("Symbol nicht verfügbar")
