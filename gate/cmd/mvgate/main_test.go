package main

import (
	"bufio"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"mvgate/securelink"
)

func fakeAgent(t *testing.T, seen chan<- *http.Request) string {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { seen <- r; io.WriteString(w, `{"ok":true}`) })
	mux.HandleFunc("GET /stream", func(w http.ResponseWriter, r *http.Request) {
		seen <- r
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "event: snap\ndata: {}\n\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { seen <- r; w.WriteHeader(http.StatusTeapot) })
	s := httptest.NewServer(mux)
	t.Cleanup(s.Close)
	return s.URL
}

// startGate runs the real mvgate stack (securelink + handler) and returns a client.
func startGate(t *testing.T, env map[string]string) (*http.Client, chan *http.Request) {
	t.Helper()
	seen := make(chan *http.Request, 16)
	m := map[string]string{"MV_GATE_UPSTREAM": fakeAgent(t, seen), "MV_GATE_STATE": t.TempDir()}
	for k, v := range env {
		m[k] = v
	}
	cfg, err := loadConfig(func(k string) string { return m[k] })
	if err != nil {
		t.Fatal(err)
	}
	id, _ := securelink.LoadOrCreateIdentity(cfg.State)
	tok := securelink.NewToken()
	inner, _ := net.Listen("tcp", "127.0.0.1:0")
	ln, err := securelink.Listen(inner, securelink.ServerConfig{Cert: id, Token: tok})
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: newHandler(cfg)}
	go srv.Serve(ln)
	t.Cleanup(func() { srv.Close() })
	p := securelink.Pairing{Addr: inner.Addr().String(), Pin: securelink.Pin(id.Leaf), Token: tok}
	return &http.Client{Transport: securelink.Transport(p), Timeout: 5 * time.Second}, seen
}

func TestConfig(t *testing.T) {
	for _, bad := range []map[string]string{{"MV_GATE_TOKEN": "short"}, {"MV_GATE_ALLOW": "nope"}, {"MV_GATE_MAX_STREAMS": "0"}} {
		if _, err := loadConfig(func(k string) string { return bad[k] }); err == nil {
			t.Errorf("accepted %v", bad)
		}
	}
	cfg, err := loadConfig(func(k string) string { return map[string]string{"MV_GATE_ALLOW": "203.0.113.7, 10.0.0.0/8"}[k] })
	if err != nil || !cfg.allowed(net.ParseIP("10.1.2.3")) || cfg.allowed(net.ParseIP("198.51.100.1")) || !cfg.allowed(net.ParseIP("127.0.0.1")) {
		t.Fatalf("allow list: %v", err)
	}
}

func TestOnlyReadRoutesAndNoHeadersForwarded(t *testing.T) {
	c, seen := startGate(t, nil)
	req, _ := http.NewRequest(http.MethodGet, "https://mvgate/healthz", nil)
	req.Header.Set("Cookie", "secret")
	req.Header.Set("X-Forwarded-For", "1.2.3.4")
	resp, err := c.Do(req)
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("%v %v", resp, err)
	}
	resp.Body.Close()
	r := <-seen
	if r.Header.Get("Cookie") != "" || r.Header.Get("X-Forwarded-For") != "" || r.Header.Get("Authorization") != "" {
		t.Errorf("headers forwarded: %v", r.Header)
	}
	for _, p := range []string{"/", "/admin", "/api/objects/x"} {
		resp, err := c.Get("https://mvgate" + p)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != 404 {
			t.Errorf("%s: %d", p, resp.StatusCode)
		}
	}
	resp, err = c.Post("https://mvgate/api/objects", "text/plain", strings.NewReader("x"))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 405 {
		t.Errorf("POST: %d", resp.StatusCode)
	}
	select {
	case r := <-seen:
		t.Errorf("%s %s reached the agent", r.Method, r.URL)
	default:
	}
}

func TestStreamFlushedAndLimited(t *testing.T) {
	c, _ := startGate(t, map[string]string{"MV_GATE_MAX_STREAMS": "1"})
	c.Timeout = 0
	resp, err := c.Get("https://mvgate/stream")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	line := make(chan string, 1)
	go func() { s, _ := bufio.NewReader(resp.Body).ReadString('\n'); line <- s }()
	select {
	case s := <-line:
		if !strings.HasPrefix(s, "event: snap") {
			t.Fatalf("first line %q", s)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("stream buffered")
	}
	r2, err := c.Get("https://mvgate/stream")
	if err != nil {
		t.Fatal(err)
	}
	r2.Body.Close()
	if r2.StatusCode != 503 {
		t.Errorf("second stream: %d", r2.StatusCode)
	}
}

func TestFailLimiter(t *testing.T) {
	now := time.Unix(0, 0)
	l := newFailLimiter(2, time.Minute, 10*time.Minute)
	l.now = func() time.Time { return now }
	ip := net.ParseIP("198.51.100.1")
	l.fail(ip)
	now = now.Add(2 * time.Minute)
	if l.fail(ip) || l.blocked(ip) {
		t.Fatal("failures in different windows blocked")
	}
	if !l.fail(ip) || !l.blocked(ip) {
		t.Fatal("not blocked")
	}
	now = now.Add(11 * time.Minute)
	if l.blocked(ip) {
		t.Fatal("block did not expire")
	}
	if l.fail(net.ParseIP("127.0.0.1")) {
		t.Fatal("loopback (health check) must never be blocked")
	}
}
