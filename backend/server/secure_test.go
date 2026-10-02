package server

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// frontStub spielt mvtls: Identifikation und die Prüfroute der Console, nur mit Key.
func frontStub(t *testing.T) (*httptest.Server, string) {
	t.Helper()
	s := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/mvtls":
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"mapviewer-tls":1,"full":false}`))
		case r.URL.Path == "/api/map/partitions" && strings.HasPrefix(r.Header.Get("Authorization"), "Bearer dak_"):
			w.Write([]byte(`{"rows":[]}`))
		default:
			w.WriteHeader(http.StatusUnauthorized)
		}
	}))
	t.Cleanup(s.Close)
	return s, CertPin(s.Certificate())
}

func allowLocalProbe(t *testing.T, front *httptest.Server) {
	t.Helper()
	_, port, _ := net.SplitHostPort(strings.TrimPrefix(front.URL, "https://"))
	oldPort, oldAllow := secureFrontPort, secureProbeAllowLocal
	secureFrontPort, secureProbeAllowLocal = port, true
	t.Cleanup(func() {
		secureFrontPort, secureProbeAllowLocal = oldPort, oldAllow
		setActivePin("")
		SetConsolePin("")
	})
}

func statusOf(t *testing.T, s *Server) map[string]any {
	t.Helper()
	w := adminCall(t, s, "GET", "/api/setup", nil)
	var m map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &m); err != nil {
		t.Fatalf("%v: %s", err, w.Body.String())
	}
	return m
}

func waitOffer(t *testing.T, s *Server) map[string]any {
	t.Helper()
	for i := 0; i < 100; i++ {
		if o, ok := statusOf(t, s)["secure"].(map[string]any); ok {
			return o
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("kein Angebot für den verschlüsselten Eingang")
	return nil
}

// Erkennung -> Angebot mit Fingerabdruck -> Bestätigung -> verschlüsselt, Eintrag ersetzt, Namen ziehen mit.
func TestSecureFrontOfferAndAccept(t *testing.T) {
	front, pin := frontStub(t)
	allowLocalProbe(t, front)
	console := consoleStub(t, false)
	s, state := storeServer(t)
	if w := connect(t, s, console.URL, "dak_test_aaaaaaaaaaaa", ""); w.Code != 200 {
		t.Fatalf("Einrichtung: %d %s", w.Code, w.Body.String())
	}
	adminCall(t, s, "POST", "/api/setup/labels", map[string]string{"1": "Mein PvE"})
	offer := waitOffer(t, s)
	if offer["pin"] != pin || offer["url"] != front.URL {
		t.Fatalf("Angebot: %+v (erwartet %s %s)", offer, front.URL, pin)
	}
	if st := statusOf(t, s); st["https"] != false {
		t.Fatalf("vor der Umstellung als verschlüsselt gemeldet: %+v", st)
	}
	// falscher Fingerabdruck wird nicht angenommen, nichts ändert sich
	if w := adminCall(t, s, "POST", "/api/setup/secure", map[string]any{"accept": true, "pin": "sha256/" + strings.Repeat("A", 43)}); w.Code != http.StatusBadRequest {
		t.Fatalf("falscher Pin: %d", w.Code)
	}
	if s.lp().cfg.APIBase != console.URL {
		t.Fatal("Verbindung trotz falschem Fingerabdruck umgestellt")
	}
	// bestätigen
	if w := adminCall(t, s, "POST", "/api/setup/secure", map[string]any{"accept": true, "pin": pin}); w.Code != 200 {
		t.Fatalf("Annahme: %d %s", w.Code, w.Body.String())
	}
	if s.lp().cfg.APIBase != front.URL || s.lp().cfg.APIPin != pin || s.lp().cfg.Token != "dak_test_aaaaaaaaaaaa" {
		t.Fatalf("aktive Verbindung: %+v", s.lp().cfg)
	}
	if st := statusOf(t, s); st["https"] != true || st["secure"] != nil {
		t.Fatalf("Status danach: %+v", st)
	}
	list := listServers(t, s)
	if len(list) != 1 || !list[0].HTTPS || !list[0].Pinned || !list[0].Active {
		t.Fatalf("Serverliste: %+v", list)
	}
	if s.customLabels()["1"] != "Mein PvE" {
		t.Fatal("Instanznamen nicht mitgezogen")
	}
	if _, err := os.Stat(filepath.Join(state, "instance-names-"+serverID(console.URL)+".json")); !os.IsNotExist(err) {
		t.Fatal("Namen des alten Eintrags nicht entfernt")
	}
	c, err := s.store.Load()
	if err != nil || c.APIBase != front.URL || c.Pin != pin {
		t.Fatalf("credentials.enc: %+v %v", c, err)
	}
}

// Ablehnen wird gemerkt; es kommt kein neues Angebot.
func TestSecureFrontDeclinePersists(t *testing.T) {
	front, _ := frontStub(t)
	allowLocalProbe(t, front)
	console := consoleStub(t, false)
	s, _ := storeServer(t)
	connect(t, s, console.URL, "dak_test_aaaaaaaaaaaa", "")
	waitOffer(t, s)
	if w := adminCall(t, s, "POST", "/api/setup/secure", map[string]any{"accept": false}); w.Code != 200 {
		t.Fatalf("%d", w.Code)
	}
	if statusOf(t, s)["secure"] != nil {
		t.Fatal("Angebot nach Ablehnen noch da")
	}
	s.refreshSecureOffer()
	time.Sleep(400 * time.Millisecond)
	if statusOf(t, s)["secure"] != nil {
		t.Fatal("abgelehntes Angebot kam wieder")
	}
	if w := adminCall(t, s, "POST", "/api/setup/secure", map[string]any{"accept": true, "pin": "x"}); w.Code != http.StatusConflict {
		t.Fatalf("Annahme ohne Angebot: %d", w.Code)
	}
}

// Bekannter Fingerabdruck (-api-pin): ohne Rückfrage umstellen.
func TestSecureFrontAutoWithKnownPin(t *testing.T) {
	front, pin := frontStub(t)
	allowLocalProbe(t, front)
	console := consoleStub(t, false)
	s, _ := storeServer(t)
	if err := SetConsolePin(pin); err != nil {
		t.Fatal(err)
	}
	connect(t, s, console.URL, "dak_test_aaaaaaaaaaaa", "")
	for i := 0; i < 100 && s.lp().cfg.APIBase != front.URL; i++ {
		time.Sleep(50 * time.Millisecond)
	}
	if s.lp().cfg.APIBase != front.URL {
		t.Fatalf("nicht automatisch umgestellt: %s", s.lp().cfg.APIBase)
	}
}

// Kein Eingang, ein fremder Dienst auf dem Port oder eine lokale Console: kein Angebot.
func TestSecureFrontNotOffered(t *testing.T) {
	console := consoleStub(t, false)
	s, _ := storeServer(t)
	connect(t, s, console.URL, "dak_test_aaaaaaaaaaaa", "") // 127.0.0.1 und kein Test-Schalter: lokal -> keine Suche
	time.Sleep(300 * time.Millisecond)
	if statusOf(t, s)["secure"] != nil {
		t.Fatal("lokale Console bekam ein Angebot")
	}
	// ein TLS-Dienst auf dem Port, der kein mvtls ist
	other := httptest.NewTLSServer(http.NotFoundHandler())
	defer other.Close()
	allowLocalProbe(t, other)
	s2, _ := storeServer(t)
	connect(t, s2, console.URL, "dak_test_aaaaaaaaaaaa", "")
	time.Sleep(500 * time.Millisecond)
	if statusOf(t, s2)["secure"] != nil {
		t.Fatal("fremder TLS-Dienst als Eingang erkannt")
	}
}
