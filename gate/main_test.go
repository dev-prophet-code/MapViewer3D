package main

import (
	"bufio"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

const testToken = "0123456789abcdef0123456789abcdef"

func env(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

// fakeAgent mimics mvagent's three routes and records what reached it.
func fakeAgent(t *testing.T, seen chan<- *http.Request) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		seen <- r
		io.WriteString(w, `{"ok":true}`)
	})
	mux.HandleFunc("GET /api/objects", func(w http.ResponseWriter, r *http.Request) {
		seen <- r
		io.WriteString(w, `{"objects":[]}`)
	})
	mux.HandleFunc("GET /stream", func(w http.ResponseWriter, r *http.Request) {
		seen <- r
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "event: snap\ndata: {}\n\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		seen <- r
		w.WriteHeader(http.StatusTeapot)
	})
	s := httptest.NewServer(mux)
	t.Cleanup(s.Close)
	return s
}

func newTestGate(t *testing.T, extra map[string]string) (*httptest.Server, chan *http.Request) {
	t.Helper()
	seen := make(chan *http.Request, 16)
	agent := fakeAgent(t, seen)
	m := map[string]string{"MV_GATE_TOKEN": testToken, "MV_GATE_UPSTREAM": agent.URL}
	for k, v := range extra {
		m[k] = v
	}
	cfg, err := loadConfig(env(m))
	if err != nil {
		t.Fatal(err)
	}
	g := httptest.NewServer(newGate(cfg))
	t.Cleanup(g.Close)
	return g, seen
}

func get(t *testing.T, u string, hdr map[string]string) *http.Response {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, u, nil)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}

func TestConfigRejectsWeakOrMissingToken(t *testing.T) {
	for _, tok := range []string{"", "short", "has:colon-0123456789abcdef", "has@at-0123456789abcdefgh"} {
		if _, err := loadConfig(env(map[string]string{"MV_GATE_TOKEN": tok})); err == nil {
			t.Errorf("token %q accepted", tok)
		}
	}
	if _, err := loadConfig(env(map[string]string{"MV_GATE_TOKEN": testToken, "MV_GATE_TLS_CERT": "x"})); err == nil {
		t.Error("cert without key accepted")
	}
	if _, err := loadConfig(env(map[string]string{"MV_GATE_TOKEN": testToken, "MV_GATE_ALLOW": "nope"})); err == nil {
		t.Error("bad allow list accepted")
	}
}

func TestBasicAuthFromURLUserInfo(t *testing.T) {
	g, seen := newTestGate(t, nil)
	// This is exactly how the MapViewer3D server calls the agent: the token
	// sits in the agent URL and Go's client turns it into Basic auth.
	u, _ := url.Parse(g.URL)
	u.User = url.UserPassword("mv", testToken)
	resp, err := http.Get(u.String() + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d", resp.StatusCode)
	}
	r := <-seen
	if r.Header.Get("Authorization") != "" {
		t.Error("token was forwarded to the agent")
	}
}

func TestBearerAndWrongToken(t *testing.T) {
	g, _ := newTestGate(t, nil)
	if s := get(t, g.URL+"/api/objects", map[string]string{"Authorization": "Bearer " + testToken}).StatusCode; s != 200 {
		t.Errorf("bearer: %d", s)
	}
	if s := get(t, g.URL+"/api/objects", map[string]string{"Authorization": "Bearer " + testToken + "x"}).StatusCode; s != 401 {
		t.Errorf("wrong token: %d", s)
	}
	if s := get(t, g.URL+"/api/objects", nil).StatusCode; s != 401 {
		t.Errorf("no token: %d", s)
	}
}

func TestOnlyAgentRoutesAndGet(t *testing.T) {
	g, seen := newTestGate(t, nil)
	auth := map[string]string{"Authorization": "Bearer " + testToken}
	for _, p := range []string{"/", "/debug", "/stream/../admin", "/api/objects/x"} {
		if s := get(t, g.URL+p, auth).StatusCode; s != 404 {
			t.Errorf("%s: %d", p, s)
		}
	}
	req, _ := http.NewRequest(http.MethodPost, g.URL+"/api/objects", nil)
	req.Header.Set("Authorization", "Bearer "+testToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 405 {
		t.Errorf("POST: %d", resp.StatusCode)
	}
	select {
	case r := <-seen:
		t.Errorf("request %s %s reached the agent", r.Method, r.URL)
	default:
	}
}

func TestStreamIsFlushedAndLimited(t *testing.T) {
	g, _ := newTestGate(t, map[string]string{"MV_GATE_MAX_STREAMS": "1"})
	auth := map[string]string{"Authorization": "Bearer " + testToken}
	resp := get(t, g.URL+"/stream", auth)
	if resp.StatusCode != 200 {
		t.Fatalf("stream: %d", resp.StatusCode)
	}
	line := make(chan string, 1)
	go func() {
		s, _ := bufio.NewReader(resp.Body).ReadString('\n')
		line <- s
	}()
	select {
	case s := <-line:
		if !strings.HasPrefix(s, "event: snap") {
			t.Fatalf("first line %q", s)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("stream data was buffered instead of flushed")
	}
	if s := get(t, g.URL+"/stream", auth).StatusCode; s != 503 {
		t.Errorf("second stream: %d", s)
	}
}

func TestAllowList(t *testing.T) {
	g, _ := newTestGate(t, map[string]string{"MV_GATE_ALLOW": "203.0.113.7"})
	if s := get(t, g.URL+"/healthz", map[string]string{"Authorization": "Bearer " + testToken}).StatusCode; s != 403 {
		t.Errorf("loopback not on the list: %d", s)
	}
	g2, _ := newTestGate(t, map[string]string{"MV_GATE_ALLOW": "127.0.0.0/8, ::1"})
	if s := get(t, g2.URL+"/healthz", map[string]string{"Authorization": "Bearer " + testToken, "X-Forwarded-For": "203.0.113.7"}).StatusCode; s != 200 {
		t.Errorf("allowed peer: %d", s)
	}
}

func TestFailedLoginsBlockTheIP(t *testing.T) {
	g, _ := newTestGate(t, nil)
	bad := map[string]string{"Authorization": "Bearer wrong"}
	for i := 0; i < 10; i++ {
		get(t, g.URL+"/healthz", bad)
	}
	if s := get(t, g.URL+"/healthz", map[string]string{"Authorization": "Bearer " + testToken}).StatusCode; s != 429 {
		t.Errorf("after 10 failures the right token still got %d", s)
	}
}

func TestFailLimiterExpires(t *testing.T) {
	now := time.Unix(0, 0)
	l := newFailLimiter(2, time.Minute, 10*time.Minute)
	l.now = func() time.Time { return now }
	ip := net.ParseIP("198.51.100.1")
	l.fail(ip)
	now = now.Add(2 * time.Minute) // window over: the count starts again
	if l.fail(ip) || l.blocked(ip) {
		t.Fatal("blocked although the failures were in different windows")
	}
	if !l.fail(ip) || !l.blocked(ip) {
		t.Fatal("not blocked after 2 failures in one window")
	}
	now = now.Add(11 * time.Minute)
	if l.blocked(ip) {
		t.Fatal("block did not expire")
	}
}
