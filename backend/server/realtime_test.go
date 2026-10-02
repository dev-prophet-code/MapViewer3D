package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// fakeConsole spielt die Console mit Realtime Data: healthz/stream nur mit dem
// richtigen Key; mode steuert, wie sie antwortet.
type fakeConsole struct {
	srv    *httptest.Server
	mode   atomic.Value // "ok", "scope", "none", "agent", "revoked"
	bearer atomic.Value
}

func newFakeConsole(t *testing.T, tlsOn bool) *fakeConsole {
	t.Helper()
	f := &fakeConsole{}
	f.mode.Store("ok")
	snap, _ := json.Marshal(agentSnap())
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.bearer.Store(r.Header.Get("Authorization"))
		mode := f.mode.Load().(string)
		if r.Header.Get("Authorization") != "Bearer dak_test" || mode == "revoked" {
			w.WriteHeader(http.StatusUnauthorized)
			w.Write([]byte(`{"error":"This API key is disabled."}`))
			return
		}
		switch mode {
		case "scope":
			w.WriteHeader(http.StatusForbidden)
			w.Write([]byte(`{"error":"This API key is not permitted to use this endpoint."}`))
			return
		case "none":
			w.WriteHeader(http.StatusForbidden)
			w.Write([]byte(`{"error":"Your account does not have permission to access this resource."}`))
			return
		case "agent":
			w.WriteHeader(http.StatusServiceUnavailable)
			w.Write([]byte(`{"available":false}`))
			return
		}
		switch r.URL.Path {
		case "/api/realtime/healthz":
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"available":true,"version":1,"ok":true}`))
		case "/api/realtime/stream":
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprintf(w, "event: snap\ndata: %s\n\n", snap)
			w.(http.Flusher).Flush()
			<-r.Context().Done()
		default:
			http.NotFound(w, r)
		}
	})
	if tlsOn {
		f.srv = httptest.NewTLSServer(h)
	} else {
		f.srv = httptest.NewServer(h)
	}
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeConsole) pin() string { return CertPin(f.srv.Certificate()) }

func withPin(t *testing.T, pin string) {
	t.Helper()
	if err := SetConsolePin(pin); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { SetConsolePin("") })
}

func runRealtime(t *testing.T, s *Server) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go s.realtimeLoop(ctx, time.Hour)
}

// HTTPS mit festgelegtem Fingerabdruck: Agent an, Daten kommen, Key im Header.
func TestRealtimeHTTPSPinned(t *testing.T) {
	c := newFakeConsole(t, true)
	withPin(t, c.pin())
	s := testServer(t, "Survival_1")
	s.setLive(&LiveConfig{APIBase: c.srv.URL, Token: "dak_test"})
	runRealtime(t, s)
	waitAgent(t, s)
	defer s.StopAgent()
	if !agentShown(t, s) {
		t.Fatal("Schalter nicht freigegeben")
	}
	if v := getView(t, s, "/api/agent/hagga"); !v.Connected || len(v.Rows) == 0 {
		t.Fatalf("keine Daten: %+v", v)
	}
	if b, _ := c.bearer.Load().(string); b != "Bearer dak_test" {
		t.Fatalf("Key nicht gesendet: %q", b)
	}
}

// Unverschlüsselt (nicht lokal), unbekanntes Zertifikat, falscher Fingerabdruck,
// fehlendes Recht, Console ohne Funktion, Agent aus: alles bleibt aus.
func TestRealtimeRefused(t *testing.T) {
	tlsConsole := newFakeConsole(t, true)
	foreignPin := "sha256/" + strings.Repeat("A", 43) // httptest-Server teilen sich ein Zertifikat
	cases := []struct {
		name, base, pin, mode, state string
	}{
		{"HTTP nicht lokal", "http://192.0.2.1:8088", "", "ok", "http"},
		{"selbst signiert ohne Pin", tlsConsole.srv.URL, "", "ok", "cert"},
		{"falscher Pin", tlsConsole.srv.URL, foreignPin, "ok", "pin"},
		{"Key ohne Realtime Data", tlsConsole.srv.URL, tlsConsole.pin(), "scope", "scope"},
		{"Console ohne Funktion", tlsConsole.srv.URL, tlsConsole.pin(), "none", "none"},
		{"Agent läuft nicht", tlsConsole.srv.URL, tlsConsole.pin(), "agent", "agent"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			withPin(t, tc.pin)
			tlsConsole.mode.Store(tc.mode)
			p := probeRealtime(context.Background(), &LiveConfig{APIBase: tc.base, Token: "dak_test"})
			if p.ok || p.state != tc.state {
				t.Fatalf("Ergebnis %+v, erwartet Zustand %q", p, tc.state)
			}
			if tc.state == "cert" && !strings.Contains(p.msg, tlsConsole.pin()) {
				t.Fatalf("Fingerabdruck fehlt in der Meldung: %s", p.msg)
			}
		})
	}
	tlsConsole.mode.Store("ok")
}

// Auf demselben Rechner darf die Console HTTP sprechen.
func TestRealtimeLocalHTTP(t *testing.T) {
	c := newFakeConsole(t, false)
	p := probeRealtime(context.Background(), &LiveConfig{APIBase: c.srv.URL, Token: "dak_test"})
	if !p.ok {
		t.Fatalf("lokale Console abgelehnt: %+v", p)
	}
}

// Wird der Key widerrufen, trennt der Viewer und blendet die Schalter wieder aus.
func TestRealtimeRevokedKeyDropsAgent(t *testing.T) {
	c := newFakeConsole(t, false)
	s := testServer(t, "Survival_1")
	s.setLive(&LiveConfig{APIBase: c.srv.URL, Token: "dak_test"})
	runRealtime(t, s)
	waitAgent(t, s)
	c.mode.Store("revoked")
	c.srv.CloseClientConnections() // Strom reißt ab, der nächste Versuch bekommt 401
	for i := 0; i < 100 && s.agentLink() != nil; i++ {
		time.Sleep(50 * time.Millisecond)
	}
	if s.agentLink() != nil || agentShown(t, s) {
		t.Fatal("Agent nach Widerruf noch aktiv")
	}
}

// Neue Zugangsdaten trennen eine bestehende Realtime-Verbindung.
func TestRealtimeNewCredentialsReconnect(t *testing.T) {
	c := newFakeConsole(t, false)
	s := testServer(t, "Survival_1")
	s.setLive(&LiveConfig{APIBase: c.srv.URL, Token: "dak_test"})
	runRealtime(t, s)
	waitAgent(t, s)
	first := s.agentLink()
	s.setLive(&LiveConfig{APIBase: c.srv.URL, Token: "dak_test"})
	for i := 0; i < 100; i++ {
		if l := s.agentLink(); l != nil && l != first {
			s.StopAgent()
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("keine neue Verbindung nach neuen Zugangsdaten")
}

func agentShown(t *testing.T, s *Server) bool {
	t.Helper()
	rec := httptest.NewRecorder()
	s.mux.ServeHTTP(rec, httptest.NewRequest("GET", "/api/live/status", nil))
	var st struct{ Agent bool }
	json.Unmarshal(rec.Body.Bytes(), &st)
	return st.Agent
}

func TestConsolePinFormat(t *testing.T) {
	for _, bad := range []string{"abc", "sha256/short", "sha1/" + strings.Repeat("A", 43)} {
		if SetConsolePin(bad) == nil {
			t.Errorf("%q angenommen", bad)
		}
	}
	SetConsolePin("")
}
