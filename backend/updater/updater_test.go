package updater

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNumber(t *testing.T) {
	for in, want := range map[string]int{"Beta.12": 12, "beta.9": 9, " Beta.1 ": 1} {
		if n, ok := Number(in); !ok || n != want {
			t.Errorf("%q: %d %v", in, n, ok)
		}
	}
	for _, in := range []string{"addon-v0.2.1", "v1", "Beta.", "dev", ""} {
		if _, ok := Number(in); ok {
			t.Errorf("%q darf keine Nummer sein", in)
		}
	}
}

func makeZip(t *testing.T, files map[string]string) []byte {
	var b bytes.Buffer
	zw := zip.NewWriter(&b)
	for n, c := range files {
		w, err := zw.Create(n)
		if err != nil {
			t.Fatal(err)
		}
		w.Write([]byte(c))
	}
	zw.Close()
	return b.Bytes()
}

// fake ist ein GitHub-Ersatz; jede Anfrage (auch an github.com) landet hier.
func fake(t *testing.T, pkg []byte, sum string, tag string) *http.Client {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/releases"):
			base := "https://github.com/" + DefaultRepo + "/releases/download/" + tag + "/"
			fmt.Fprintf(w, `[{"tag_name":"addon-v9.9.9","assets":[]},{"tag_name":%q,"html_url":"https://github.com/x/y/releases/tag/%s","body":"neu","assets":[`+
				`{"name":"MapViewer3D-update-Beta.13.zip","browser_download_url":%q},`+
				`{"name":"MapViewer3D-update-Beta.13.zip.sha256","browser_download_url":%q},`+
				`{"name":"evil.zip","browser_download_url":"https://evil.example/x"}]},`+
				`{"tag_name":"beta.12","assets":[]}]`, tag, tag, base+"MapViewer3D-update-Beta.13.zip", base+"MapViewer3D-update-Beta.13.zip.sha256")
		case strings.HasSuffix(r.URL.Path, ".zip.sha256"):
			fmt.Fprintf(w, "%s  MapViewer3D-update-Beta.13.zip\n", sum)
		case strings.HasSuffix(r.URL.Path, ".zip"):
			w.Write(pkg)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	u, _ := url.Parse(srv.URL)
	return &http.Client{Transport: rewrite{u}}
}

type rewrite struct{ to *url.URL }

func (r rewrite) RoundTrip(req *http.Request) (*http.Response, error) {
	req = req.Clone(req.Context())
	req.URL.Scheme, req.URL.Host = r.to.Scheme, r.to.Host
	return http.DefaultTransport.RoundTrip(req)
}

func shaOf(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }

func testUpdater(t *testing.T, root string, client *http.Client, restarted *bool) *Updater {
	exe := filepath.Join(root, "bin", "mapviewer-test")
	return New(Config{
		Current: "Beta.12", Work: root, Client: client,
		Plan: func(stage string) ([]Op, error) {
			return []Op{{filepath.Join(stage, "bin", "mapviewer-test"), exe}, {filepath.Join(stage, "viewer"), filepath.Join(root, "viewer")}}, nil
		},
		Restart: func() { *restarted = true },
	})
}

func setupRoot(t *testing.T) string {
	root := t.TempDir()
	os.MkdirAll(filepath.Join(root, "bin"), 0o755)
	os.MkdirAll(filepath.Join(root, "viewer"), 0o755)
	os.WriteFile(filepath.Join(root, "bin", "mapviewer-test"), []byte("alt"), 0o755)
	os.WriteFile(filepath.Join(root, "viewer", "index.html"), []byte("alt"), 0o644)
	os.MkdirAll(filepath.Join(root, "state"), 0o755)
	os.WriteFile(filepath.Join(root, "state", "credentials.enc"), []byte("geheim"), 0o600)
	return root
}

func read(t *testing.T, p string) string {
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestCheckPicksNewestBeta(t *testing.T) {
	root := setupRoot(t)
	var restarted bool
	u := testUpdater(t, root, fake(t, nil, "", "beta.13"), &restarted)
	u.cfg.APIBase = "https://api.github.com"
	if err := u.Check(context.Background()); err != nil {
		t.Fatal(err)
	}
	st := u.Status()
	if st.Latest != "Beta.13" || !st.Available || !st.CanApply || st.Notes != "neu" {
		t.Fatalf("%+v", st)
	}
}

func TestInstallReplacesAndKeepsState(t *testing.T) {
	root := setupRoot(t)
	pkg := makeZip(t, map[string]string{"MapViewer3D/bin/mapviewer-test": "neu", "MapViewer3D/viewer/index.html": "neu"})
	var restarted bool
	u := testUpdater(t, root, fake(t, pkg, shaOf(pkg), "beta.13"), &restarted)
	ctx := context.Background()
	if err := u.Check(ctx); err != nil {
		t.Fatal(err)
	}
	if err := u.Install(ctx); err != nil {
		t.Fatal(err)
	}
	if !restarted {
		t.Fatal("kein Neustart")
	}
	if read(t, filepath.Join(root, "bin", "mapviewer-test")) != "neu" || read(t, filepath.Join(root, "viewer", "index.html")) != "neu" {
		t.Fatal("nicht ersetzt")
	}
	if read(t, filepath.Join(root, "state", "credentials.enc")) != "geheim" {
		t.Fatal("state angefasst")
	}
	if read(t, filepath.Join(root, ".update", "backup-Beta.12", "00-mapviewer-test")) != "alt" {
		t.Fatal("keine Sicherung")
	}
	if _, err := os.Stat(filepath.Join(root, ".update", "stage")); err == nil {
		t.Fatal("Staging nicht aufgeräumt")
	}
}

func TestInstallRejectsWrongChecksum(t *testing.T) {
	root := setupRoot(t)
	pkg := makeZip(t, map[string]string{"bin/mapviewer-test": "neu", "viewer/index.html": "neu"})
	var restarted bool
	u := testUpdater(t, root, fake(t, pkg, strings.Repeat("0", 64), "beta.13"), &restarted)
	u.Check(context.Background())
	if err := u.Install(context.Background()); err == nil || !strings.Contains(err.Error(), "SHA-256") {
		t.Fatalf("erwartet SHA-Fehler, erhalten %v", err)
	}
	if restarted || read(t, filepath.Join(root, "bin", "mapviewer-test")) != "alt" {
		t.Fatal("trotz falscher Summe installiert")
	}
}

func TestUnzipRejectsEscape(t *testing.T) {
	dir := t.TempDir()
	zp := filepath.Join(dir, "x.zip")
	os.WriteFile(zp, makeZip(t, map[string]string{"../evil": "x", "a/b": "y"}), 0o644)
	if err := Unzip(zp, filepath.Join(dir, "out")); err == nil {
		t.Fatal("Pfad-Ausbruch nicht abgelehnt")
	}
	if _, err := os.Stat(filepath.Join(dir, "evil")); err == nil {
		t.Fatal("Datei außerhalb geschrieben")
	}
}

func TestApplyRollsBack(t *testing.T) {
	root := t.TempDir()
	a, b := filepath.Join(root, "a"), filepath.Join(root, "b")
	os.WriteFile(a, []byte("alt-a"), 0o644)
	os.WriteFile(b, []byte("alt-b"), 0o644)
	newA := filepath.Join(root, "stage-a")
	os.WriteFile(newA, []byte("neu-a"), 0o644)
	// zweite Operation scheitert (Quelle fehlt) -> a muss zurück auf alt
	err := Apply([]Op{{newA, a}, {filepath.Join(root, "fehlt"), b}}, filepath.Join(root, "bak"))
	if err == nil {
		t.Fatal("Fehler erwartet")
	}
	if read(t, a) != "alt-a" || read(t, b) != "alt-b" {
		t.Fatalf("Rollback unvollständig: %q %q", read(t, a), read(t, b))
	}
}
