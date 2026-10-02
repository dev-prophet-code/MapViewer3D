package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"mapviewer3d/secure"
)

// consoleStub antwortet wie eine Console auf die Prüfung der Einrichtung.
func consoleStub(t *testing.T, tlsOn bool) *httptest.Server {
	t.Helper()
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer dak_") {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if r.URL.Path == "/api/map/partitions" {
			w.Write([]byte(`{"rows":[]}`))
			return
		}
		http.NotFound(w, r)
	})
	var s *httptest.Server
	if tlsOn {
		s = httptest.NewTLSServer(h)
	} else {
		s = httptest.NewServer(h)
	}
	t.Cleanup(s.Close)
	return s
}

func storeServer(t *testing.T) (*Server, string) {
	t.Helper()
	state := t.TempDir()
	st, err := secure.Open(filepath.Join(state, "credentials.enc"), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return New(t.TempDir(), t.TempDir(), state, st), state
}

func adminCall(t *testing.T, s *Server, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var b []byte
	if body != nil {
		b, _ = json.Marshal(body)
	}
	r := httptest.NewRequest(method, "http://localhost:8795"+path, bytes.NewReader(b))
	r.RemoteAddr, r.Host = "127.0.0.1:5000", "localhost:8795"
	r.Header.Set("X-MapViewer", "1")
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	s.mux.ServeHTTP(w, r)
	return w
}

func connect(t *testing.T, s *Server, server, token, pin string) *httptest.ResponseRecorder {
	t.Helper()
	return adminCall(t, s, "POST", "/api/setup", map[string]any{"server": server, "token": token, "pin": pin})
}

func listServers(t *testing.T, s *Server) []serverEntry {
	t.Helper()
	w := adminCall(t, s, "GET", "/api/servers", nil)
	var out []serverEntry
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("%v: %s", err, w.Body.String())
	}
	return out
}

func TestServerListSwitch(t *testing.T) {
	a, b := consoleStub(t, false), consoleStub(t, false)
	s, state := storeServer(t)
	if w := connect(t, s, a.URL, "dak_aaaaaaaaaaaa", ""); w.Code != 200 {
		t.Fatalf("A: %d %s", w.Code, w.Body.String())
	}
	if w := connect(t, s, b.URL, "dak_bbbbbbbbbbbb", ""); w.Code != 200 {
		t.Fatalf("B: %d %s", w.Code, w.Body.String())
	}
	list := listServers(t, s)
	if len(list) != 2 {
		t.Fatalf("Liste: %+v", list)
	}
	raw := adminCall(t, s, "GET", "/api/servers", nil).Body.String()
	if strings.Contains(raw, "dak_") || strings.Contains(raw, "aaaa") || strings.Contains(raw, "bbbb") {
		t.Fatal("Token in der Serverliste")
	}
	idA := serverID(a.URL)
	for _, e := range list {
		if e.Active != (e.ID == serverID(b.URL)) {
			t.Fatalf("aktiver Server falsch: %+v", list)
		}
	}
	// Instanznamen gehören zum Server
	adminCall(t, s, "POST", "/api/setup/labels", map[string]string{"1": "Server B PvE"})
	// zu A wechseln
	if w := adminCall(t, s, "POST", "/api/servers/"+idA+"/use", nil); w.Code != 200 {
		t.Fatalf("Wechsel: %d %s", w.Code, w.Body.String())
	}
	if s.lp() == nil || s.lp().cfg.APIBase != a.URL || s.lp().cfg.Token != "dak_aaaaaaaaaaaa" {
		t.Fatal("aktive Verbindung nicht A")
	}
	if s.customLabels()["1"] != "" {
		t.Fatal("Instanznamen von B gelten auch für A")
	}
	// Neustart startet mit dem zuletzt gewählten Server
	c, err := s.store.Load()
	if err != nil || c.APIBase != a.URL {
		t.Fatalf("credentials.enc: %+v %v", c, err)
	}
	// B entfernen
	adminCall(t, s, "DELETE", "/api/servers/"+serverID(b.URL), nil)
	if l := listServers(t, s); len(l) != 1 || l[0].ID != idA {
		t.Fatalf("nach Entfernen: %+v", l)
	}
	if _, err := os.Stat(filepath.Join(state, "instance-names-"+serverID(b.URL)+".json")); !os.IsNotExist(err) {
		t.Fatal("Namen von B nicht entfernt")
	}
}

func TestServerListRemoteForbidden(t *testing.T) {
	a := consoleStub(t, false)
	s, _ := storeServer(t)
	connect(t, s, a.URL, "dak_aaaaaaaaaaaa", "")
	r := httptest.NewRequest("GET", "http://map.example.org/api/servers", nil)
	r.RemoteAddr, r.Host = "198.51.100.7:4000", "map.example.org"
	w := httptest.NewRecorder()
	s.mux.ServeHTTP(w, r)
	if strings.TrimSpace(w.Body.String()) != "[]" {
		t.Fatalf("Besucher sieht die Serverliste: %s", w.Body.String())
	}
	r = httptest.NewRequest("POST", "http://map.example.org/api/servers/"+serverID(a.URL)+"/use", nil)
	r.RemoteAddr, r.Host = "198.51.100.7:4000", "map.example.org"
	r.Header.Set("X-MapViewer", "1")
	w = httptest.NewRecorder()
	s.mux.ServeHTTP(w, r)
	if w.Code != http.StatusForbidden {
		t.Fatalf("Besucher darf umschalten: %d", w.Code)
	}
}

// Internes Zertifikat: ohne Fingerabdruck abgelehnt (mit Vorschlag), mit ihm verbunden.
func TestSetupPinnedCertificate(t *testing.T) {
	c := consoleStub(t, true)
	s, _ := storeServer(t)
	w := connect(t, s, c.URL, "dak_cccccccccccc", "")
	var e struct{ Code, Detail string }
	json.Unmarshal(w.Body.Bytes(), &e)
	pin := CertPin(c.Certificate())
	if w.Code != http.StatusBadGateway || e.Code != "cert_untrusted" || e.Detail != pin {
		t.Fatalf("ohne Pin: %d %+v", w.Code, e)
	}
	if w := connect(t, s, c.URL, "dak_cccccccccccc", "sha256/"+strings.Repeat("A", 43)); w.Code != http.StatusBadGateway || !strings.Contains(w.Body.String(), "cert_pin") {
		t.Fatalf("falscher Pin: %d %s", w.Code, w.Body.String())
	}
	if w := connect(t, s, c.URL, "dak_cccccccccccc", pin); w.Code != 200 {
		t.Fatalf("mit Pin: %d %s", w.Code, w.Body.String())
	}
	if l := listServers(t, s); len(l) != 1 || !l[0].Pinned || !l[0].HTTPS {
		t.Fatalf("Liste: %+v", l)
	}
	if currentConsolePin() != pin {
		t.Fatal("Fingerabdruck der aktiven Verbindung nicht gesetzt")
	}
	t.Cleanup(func() { setActivePin("") })
}

func TestNormalizeServerHTTPS(t *testing.T) {
	for in, want := range map[string]string{
		"https://dune.example.org":      "https://dune.example.org:443",
		"https://dune.example.org:8443": "https://dune.example.org:8443",
		"dune.example.org":              "http://dune.example.org:8088",
		"http://dune.example.org":       "http://dune.example.org:8088",
	} {
		if got, _, err := normalizeServer(in, 8088); err != nil || got != want {
			t.Errorf("%s: %s %v, erwartet %s", in, got, err, want)
		}
	}
}
