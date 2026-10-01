package server

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"testing"
	"time"

	"mapviewer3d/securelink"
)

// fakeGate ist ein mvgate-Ersatz: securelink davor, /healthz und der Strom von fakeAgent dahinter.
func fakeGate(t *testing.T) securelink.Pairing {
	t.Helper()
	a := fakeAgent(t, agentSnap(), `{"gen":1,"t":1,"d":[[1,111,222,6]],"r":[]}`)
	t.Cleanup(a.Close)
	u, _ := url.Parse(a.URL)
	proxy := httputil.NewSingleHostReverseProxy(u)
	proxy.FlushInterval = -1
	id, err := securelink.LoadOrCreateIdentity(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	tok := securelink.NewToken()
	inner, _ := net.Listen("tcp", "127.0.0.1:0")
	ln, err := securelink.Listen(inner, securelink.ServerConfig{Cert: id, Token: tok})
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/healthz" {
			w.Write([]byte(`{"ok":true}`))
			return
		}
		proxy.ServeHTTP(w, r)
	})}
	go srv.Serve(ln)
	t.Cleanup(func() { srv.Close() })
	return securelink.Pairing{Addr: inner.Addr().String(), Pin: securelink.Pin(id.Leaf), Token: tok}
}

func agentShown(t *testing.T, s *Server) bool {
	t.Helper()
	rec := httptest.NewRecorder()
	s.mux.ServeHTTP(rec, httptest.NewRequest("GET", "/api/live/status", nil))
	var st struct{ Agent bool }
	json.Unmarshal(rec.Body.Bytes(), &st)
	return st.Agent
}

func discover(t *testing.T, s *Server, p *securelink.Pairing) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go s.liveDiscovery(ctx, p, time.Hour)
}

// Gekoppelt und der Server antwortet: Agent an, Schalter sichtbar, Daten fließen verschlüsselt.
func TestLiveDiscoveryPaired(t *testing.T) {
	s := testServer(t, "Survival_1")
	p := fakeGate(t)
	discover(t, s, &p)
	waitAgent(t, s)
	defer s.StopAgent()
	if !agentShown(t, s) {
		t.Fatal("Schalter nicht freigegeben")
	}
	if v := getView(t, s, "/api/agent/hagga"); !v.Connected || len(v.Rows) == 0 {
		t.Fatalf("keine Daten über securelink: %+v", v)
	}
	if l := s.agentLink(); l == nil || l.label != p.String() {
		t.Fatal("Log-Name des Agenten falsch")
	}
}

// Keine Antwort (nichts lauscht), falscher Schlüssel, falsches Token: Agent bleibt aus.
func TestLiveDiscoveryRefused(t *testing.T) {
	good := fakeGate(t)
	dead, _ := net.Listen("tcp", "127.0.0.1:0")
	deadAddr := dead.Addr().String()
	dead.Close()
	other, _ := securelink.LoadOrCreateIdentity(t.TempDir())
	cases := map[string]securelink.Pairing{
		"keine Antwort":      {Addr: deadAddr, Pin: good.Pin, Token: good.Token},
		"falscher Schlüssel": {Addr: good.Addr, Pin: securelink.Pin(other.Leaf), Token: good.Token},
		"falsches Token":     {Addr: good.Addr, Pin: good.Pin, Token: securelink.NewToken()},
	}
	for name, p := range cases {
		s := testServer(t, "Survival_1")
		discover(t, s, &p)
		time.Sleep(700 * time.Millisecond)
		if s.agentLink() != nil || agentShown(t, s) {
			t.Errorf("%s: Agent eingeschaltet", name)
		}
	}
}

// Ohne Kopplung: Console kennt die Funktion nicht (404) oder schweigt -> aus, und zwar schnell.
func TestLiveDiscoveryConsoleWithoutFeature(t *testing.T) {
	console := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == consoleLivePath && r.Header.Get("Authorization") == "Bearer dak_test" {
			http.NotFound(w, r) // heutige Dune-Docker-Console
			return
		}
		t.Errorf("unerwartete Anfrage %s", r.URL)
	}))
	defer console.Close()
	s := testServer(t, "Survival_1")
	s.setLive(&LiveConfig{APIBase: console.URL, Token: "dak_test"})
	if o, err := askConsole(context.Background(), s.lp().cfg); err == nil || o.Available {
		t.Fatalf("404 als Angebot gewertet: %+v %v", o, err)
	}
	discover(t, s, nil)
	time.Sleep(300 * time.Millisecond)
	if agentShown(t, s) {
		t.Fatal("Schalter ohne Funktion sichtbar")
	}

	hang := make(chan struct{})
	silent := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-hang }))
	defer silent.Close()
	defer close(hang)
	start := time.Now()
	if _, err := askConsole(context.Background(), &LiveConfig{APIBase: silent.URL, Token: "dak_test"}); err == nil {
		t.Fatal("stumme Console als Antwort gewertet")
	}
	if d := time.Since(start); d > liveProbeTimeout+time.Second {
		t.Fatalf("Anfrage dauerte %v", d)
	}
}

// Bietet eine künftige Console die Funktion an, schaltet das allein noch nichts frei.
func TestLiveDiscoveryOfferNeedsPairing(t *testing.T) {
	console := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"available":true,"version":1}`))
	}))
	defer console.Close()
	s := testServer(t, "Survival_1")
	s.setLive(&LiveConfig{APIBase: console.URL, Token: "dak_test"})
	if o, err := askConsole(context.Background(), s.lp().cfg); err != nil || !o.Available {
		t.Fatalf("Angebot nicht erkannt: %v", err)
	}
	discover(t, s, nil)
	time.Sleep(300 * time.Millisecond)
	if agentShown(t, s) {
		t.Fatal("ohne Kopplungscode freigeschaltet")
	}
}
