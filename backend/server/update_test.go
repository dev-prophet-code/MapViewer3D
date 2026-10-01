package server

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"mapviewer3d/updater"
)

func updReq(method, remote, host string) *http.Request {
	r := httptest.NewRequest(method, "http://"+host+"/api/update/install", nil)
	r.RemoteAddr, r.Host = remote, host
	r.Header.Set("X-MapViewer", "1")
	return r
}

func TestUpdateEndpointsAreAdminOnly(t *testing.T) {
	u := updater.New(updater.Config{Current: "Beta.12", Work: t.TempDir()})
	s := &Server{upd: u}
	// entfernter Aufrufer (Reverse-Proxy / anderes Gerät): verboten
	for _, c := range [][2]string{{"192.168.1.9:5000", "192.168.1.5:8795"}, {"127.0.0.1:5000", "map.example.org"}} {
		w := httptest.NewRecorder()
		if s.updateAllowed(w, updReq("POST", c[0], c[1])) || w.Code != http.StatusForbidden {
			t.Errorf("%v: %d, erwartet 403", c, w.Code)
		}
	}
	// lokaler Browser: erlaubt; fremder Origin: verboten
	if !s.updateAllowed(httptest.NewRecorder(), updReq("POST", "127.0.0.1:5000", "localhost:8795")) {
		t.Error("lokal sollte erlaubt sein")
	}
	r := updReq("POST", "127.0.0.1:5000", "localhost:8795")
	r.Header.Set("Origin", "https://evil.example")
	if s.updateAllowed(httptest.NewRecorder(), r) {
		t.Error("fremder Origin muss abgelehnt werden")
	}
}

func TestUpdateHiddenWhenPublicOrDisabled(t *testing.T) {
	for name, s := range map[string]*Server{
		"public":   {upd: updater.New(updater.Config{Current: "Beta.12", Work: t.TempDir()}), public: &publicGate{}},
		"disabled": {},
	} {
		w := httptest.NewRecorder()
		s.updateStatus(w, updReq("GET", "127.0.0.1:5000", "localhost:8795"))
		if got := w.Body.String(); got != "{\"enabled\":false}\n" {
			t.Errorf("%s: %q", name, got)
		}
		if s.updateAllowed(httptest.NewRecorder(), updReq("POST", "127.0.0.1:5000", "localhost:8795")) {
			t.Errorf("%s: Installation darf nicht erlaubt sein", name)
		}
	}
}
