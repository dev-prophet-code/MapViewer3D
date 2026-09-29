package secure

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRoundTripAndTamper(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(filepath.Join(dir, "state", "credentials.enc"), filepath.Join(dir, "keys"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Load(); err != ErrNotConfigured {
		t.Fatalf("erwartet ErrNotConfigured, bekam %v", err)
	}
	in := Credentials{APIBase: "http://example.invalid:8088", Token: "dak_test_secret"}
	if err := s.Save(in); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(filepath.Join(dir, "state", "credentials.enc"))
	if strings.Contains(string(raw), "dak_test_secret") || strings.Contains(string(raw), "example") {
		t.Fatal("Klartext in der Datei")
	}
	out, err := s.Load()
	if err != nil || *out != in {
		t.Fatalf("Rundreise fehlgeschlagen: %v %+v", err, out)
	}
	// Manipulation erkennen
	bad := strings.Replace(string(raw), `"v": 1`, `"v": 1, "x": 1`, 1)
	bad = strings.Replace(bad, `"fps": "`, `"fps": "AA`, 1)
	os.WriteFile(filepath.Join(dir, "state", "credentials.enc"), []byte(bad), 0o600)
	if _, err := s.Load(); err == nil {
		t.Fatal("Manipulation nicht erkannt")
	}
	// Anderer Hauptschlüssel → nicht lesbar
	os.WriteFile(filepath.Join(dir, "state", "credentials.enc"), raw, 0o600)
	os.WriteFile(filepath.Join(dir, "keys", "master.key"), make([]byte, 32), 0o600)
	if _, err := s.Load(); err == nil {
		t.Fatal("fremder Schlüssel akzeptiert")
	}
}
