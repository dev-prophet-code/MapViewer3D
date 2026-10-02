package server

import (
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func req(remote, host string, hdr map[string]string) *http.Request {
	r := httptest.NewRequest("POST", "http://"+host+"/api/setup", nil)
	r.RemoteAddr = remote
	r.Host = host
	for k, v := range hdr {
		r.Header.Set(k, v)
	}
	return r
}

func TestAdminAllowed(t *testing.T) {
	cases := []struct {
		name                 string
		remote               string
		host                 string
		hdr                  map[string]string
		remoteSetup, noLocal bool
		want                 bool
	}{
		{"local browser", "127.0.0.1:5000", "localhost:8795", nil, false, false, true},
		{"local ip host", "127.0.0.1:5000", "127.0.0.1:8795", nil, false, false, true},
		{"local ipv6", "[::1]:5000", "[::1]:8795", nil, false, false, true},
		{"proxy without headers, public Host (the reported fail-open case)", "127.0.0.1:5000", "map.example.org", nil, false, false, false},
		{"proxy with forwarded header", "127.0.0.1:5000", "localhost:8795", map[string]string{"X-Forwarded-For": "8.8.8.8"}, false, false, false},
		{"proxy with forwarded host", "127.0.0.1:5000", "localhost:8795", map[string]string{"X-Forwarded-Host": "map.example.org"}, false, false, false},
		{"remote client", "192.168.1.9:5000", "192.168.1.5:8795", nil, false, false, false},
		{"remote client spoofing Host", "192.168.1.9:5000", "localhost:8795", nil, false, false, false},
		{"dns rebinding", "127.0.0.1:5000", "evil.example:8795", nil, false, false, false},
		{"no-local-admin", "127.0.0.1:5000", "localhost:8795", nil, false, true, false},
		{"remote-setup", "192.168.1.9:5000", "192.168.1.5:8795", nil, true, false, true},
	}
	for _, c := range cases {
		s := &Server{RemoteSetup: c.remoteSetup, NoLocalAdmin: c.noLocal}
		if got := s.adminAllowed(req(c.remote, c.host, c.hdr)); got != c.want {
			t.Errorf("%s: adminAllowed = %v, want %v", c.name, got, c.want)
		}
	}
}

func TestBlockSpecialTargets(t *testing.T) {
	for addr, blocked := range map[string]bool{
		"169.254.169.254:80": true, // Cloud-Metadaten
		"[fe80::1]:80":       true,
		"224.0.0.1:80":       true,
		"0.0.0.0:80":         true,
		"127.0.0.1:8088":     false, // Console auf demselben Rechner
		"192.168.1.10:8088":  false, // Console im LAN
		"10.0.0.2:8088":      false,
	} {
		err := blockSpecialTargets("tcp", addr, nil)
		if (err != nil) != blocked {
			t.Errorf("%s: blocked=%v, want %v", addr, err != nil, blocked)
		}
	}
}

func TestCheckConsoleCollapsesErrorsForRemote(t *testing.T) {
	// Metadaten-Adresse: bei entferntem Aufrufer nur der Sammelfehler ohne Details
	err := checkConsole("http://169.254.169.254:80", "dak_test_token", "", false)
	se, ok := err.(*setupError)
	if !ok || se.code != "unreachable" || se.detail != "" {
		t.Fatalf("remote caller got %#v", err)
	}
	// Lokaler Aufrufer sieht weiterhin, dass es nicht erreichbar ist
	err = checkConsole("http://169.254.169.254:80", "dak_test_token", "", true)
	if se, ok := err.(*setupError); !ok || se.code != "unreachable" {
		t.Fatalf("local caller got %#v", err)
	}
}

func TestCheckConsoleDoesNotFollowRedirects(t *testing.T) {
	hit := false
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hit = true }))
	defer target.Close()
	redir := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusFound)
	}))
	defer redir.Close()
	err := checkConsole(redir.URL, "dak_test_token", "", true)
	if hit {
		t.Fatal("redirect was followed")
	}
	if se, ok := err.(*setupError); !ok || se.code != "http_status" {
		t.Fatalf("got %#v", err)
	}
}

func TestStripPrivate(t *testing.T) {
	s := &Server{}
	body := `{"rows":[{"id":1,"name":"A","account_id":"x","funcom_id":"y","nested":{"fls_id":"z","keep":2}},{"action_player_id":"q","type":"player"}]}`
	c := &cached{at: time.Now(), status: 200, body: []byte(body)}
	out := s.stripPrivate("/p", c)
	for _, k := range privateFields {
		if strings.Contains(string(out.body), k) {
			t.Errorf("%s still present: %s", k, out.body)
		}
	}
	for _, keep := range []string{`"name":"A"`, `"keep":2`, `"type":"player"`, `"id":1`} {
		if !strings.Contains(string(out.body), keep) {
			t.Errorf("lost %s: %s", keep, out.body)
		}
	}
	// zweiter Aufruf mit gleichem Zeitstempel kommt aus dem Zwischenspeicher
	if again := s.stripPrivate("/p", c); string(again.body) != string(out.body) {
		t.Error("cache mismatch")
	}
	// Fehlerantworten bleiben unverändert
	e := &cached{at: time.Now(), status: 502, body: []byte(`{"error":"x"}`)}
	if s.stripPrivate("/e", e) != e {
		t.Error("error response was modified")
	}
}

func TestContentSecurityPolicy(t *testing.T) {
	dir := t.TempDir()
	html := `<html><script type="importmap">{"imports":{"three":"./v/three.js"}}</script><script type="module" src="js/main.js"></script></html>`
	file := dir + "/index.html"
	if err := os.WriteFile(file, []byte(html), 0o600); err != nil {
		t.Fatal(err)
	}
	csp := contentSecurityPolicy(file)
	sum := sha256.Sum256([]byte(`{"imports":{"three":"./v/three.js"}}`))
	want := "'sha256-" + base64.StdEncoding.EncodeToString(sum[:]) + "'"
	if !strings.Contains(csp, "script-src 'self' "+want) {
		t.Errorf("import map hash missing: %s", csp)
	}
	if strings.Contains(csp, "unsafe-eval") || strings.Contains(csp, "cdn.") || strings.Contains(csp, "frame-ancestors") {
		t.Errorf("unexpected directive: %s", csp)
	}
	if contentSecurityPolicy(dir+"/missing.html") != "" {
		t.Error("missing file should give empty policy")
	}
}

func TestViewerPassword(t *testing.T) {
	s := New(t.TempDir(), t.TempDir(), t.TempDir(), nil)
	get := func(user, pw string, auth bool) int {
		r := httptest.NewRequest("GET", "http://x/api/version", nil)
		if auth {
			r.SetBasicAuth(user, pw)
		}
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		return w.Code
	}
	if got := get("", "", false); got != 200 {
		t.Fatalf("ohne Passwort gesetzt: %d, erwartet 200", got)
	}
	s.SetPassword("geheim")
	if !s.HasPassword() {
		t.Fatal("HasPassword")
	}
	if got := get("", "", false); got != 401 {
		t.Fatalf("ohne Login: %d, erwartet 401", got)
	}
	if got := get("x", "falsch", true); got != 401 {
		t.Fatalf("falsches Passwort: %d, erwartet 401", got)
	}
	if got := get("irgendwer", "geheim", true); got != 200 {
		t.Fatalf("richtiges Passwort: %d, erwartet 200", got)
	}
	r := httptest.NewRequest("GET", "http://x/", nil)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Header().Get("WWW-Authenticate") == "" {
		t.Fatal("WWW-Authenticate fehlt")
	}
}
