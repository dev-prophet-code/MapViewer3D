// mvgate is the authenticated front door for the MapViewer3D position agent
// (mvagent) on a Dune Docker host.
//
// mvagent has no login and only belongs on loopback or an internal network.
// mvgate is the only published port: it checks a token, optionally an IP allow
// list, forwards the three read-only agent routes and nothing else.
//
// A local MapViewer3D connects with
//
//	-agent https://mv:<TOKEN>@your-server:8797
//
// (Go sends the user info of the URL as HTTP Basic auth). Bearer tokens work too.
package main

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const minTokenLen = 24

type config struct {
	Addr       string
	Upstream   *url.URL
	Token      string
	Allow      []*net.IPNet
	MaxStreams int
	TLSCert    string
	TLSKey     string
}

func main() {
	health := flag.Bool("healthcheck", false, "check the local gate and exit (for the container health check)")
	flag.Parse()

	cfg, err := loadConfig(os.Getenv)
	if *health {
		os.Exit(healthcheck(cfg, err))
	}
	if err != nil {
		log.Fatal(err)
	}
	g := newGate(cfg)
	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           g,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
		MaxHeaderBytes:    16 << 10,
		TLSConfig:         &tls.Config{MinVersion: tls.VersionTLS12},
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		srv.Shutdown(sctx)
	}()

	scheme := "http"
	if cfg.TLSCert != "" {
		scheme = "https"
	}
	log.Printf("mvgate: %s://%s -> %s (allow list: %d entries, max streams: %d)", scheme, cfg.Addr, cfg.Upstream, len(cfg.Allow), cfg.MaxStreams)
	if scheme == "http" {
		log.Printf("mvgate: no TLS – token and positions travel in clear text; use TLS, a VPN or an SSH tunnel when the port is reachable from the internet")
	}
	if scheme == "https" {
		err = srv.ListenAndServeTLS(cfg.TLSCert, cfg.TLSKey)
	} else {
		err = srv.ListenAndServe()
	}
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

func loadConfig(env func(string) string) (config, error) {
	cfg := config{
		Addr:       envOr(env, "MV_GATE_ADDR", ":8797"),
		Token:      strings.TrimSpace(env("MV_GATE_TOKEN")),
		MaxStreams: 8,
		TLSCert:    env("MV_GATE_TLS_CERT"),
		TLSKey:     env("MV_GATE_TLS_KEY"),
	}
	if f := env("MV_GATE_TOKEN_FILE"); f != "" && cfg.Token == "" {
		b, err := os.ReadFile(f)
		if err != nil {
			return cfg, fmt.Errorf("MV_GATE_TOKEN_FILE: %v", err)
		}
		cfg.Token = strings.TrimSpace(string(b))
	}
	if len(cfg.Token) < minTokenLen {
		return cfg, fmt.Errorf("MV_GATE_TOKEN must be set and at least %d characters long (e.g. openssl rand -hex 24)", minTokenLen)
	}
	if strings.ContainsAny(cfg.Token, ":@/ ") {
		return cfg, errors.New("MV_GATE_TOKEN must not contain ':', '@', '/' or spaces (it is used inside a URL)")
	}
	u, err := url.Parse(envOr(env, "MV_GATE_UPSTREAM", "http://mvagent:8796"))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return cfg, fmt.Errorf("MV_GATE_UPSTREAM: expected http://host:port")
	}
	cfg.Upstream = u
	if s := env("MV_GATE_MAX_STREAMS"); s != "" {
		n, err := strconv.Atoi(s)
		if err != nil || n < 1 {
			return cfg, fmt.Errorf("MV_GATE_MAX_STREAMS: %q is not a positive number", s)
		}
		cfg.MaxStreams = n
	}
	for _, part := range strings.FieldsFunc(env("MV_GATE_ALLOW"), func(r rune) bool { return r == ',' || r == ' ' }) {
		if !strings.Contains(part, "/") {
			if ip := net.ParseIP(part); ip != nil && ip.To4() != nil {
				part += "/32"
			} else {
				part += "/128"
			}
		}
		_, n, err := net.ParseCIDR(part)
		if err != nil {
			return cfg, fmt.Errorf("MV_GATE_ALLOW: %q is not an IP or CIDR", part)
		}
		cfg.Allow = append(cfg.Allow, n)
	}
	if (cfg.TLSCert == "") != (cfg.TLSKey == "") {
		return cfg, errors.New("MV_GATE_TLS_CERT and MV_GATE_TLS_KEY must be set together")
	}
	return cfg, nil
}

func envOr(env func(string) string, k, def string) string {
	if v := env(k); v != "" {
		return v
	}
	return def
}

// routes the gate forwards; everything else is 404.
var routes = map[string]bool{"/healthz": true, "/stream": true, "/api/objects": true}

type gate struct {
	cfg     config
	tokenH  [32]byte
	proxy   *httputil.ReverseProxy
	streams chan struct{}
	fails   *failLimiter
}

func newGate(cfg config) *gate {
	g := &gate{
		cfg:     cfg,
		tokenH:  sha256.Sum256([]byte(cfg.Token)),
		streams: make(chan struct{}, cfg.MaxStreams),
		fails:   newFailLimiter(10, time.Minute, 10*time.Minute),
	}
	g.proxy = &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(cfg.Upstream)
			r.Out.Header.Del("Authorization")
			r.Out.Header.Del("Cookie")
			r.Out.Header.Del("X-Forwarded-For")
		},
		FlushInterval: -1, // server-sent events: pass every write on at once
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			log.Printf("mvgate: agent unreachable: %v", err)
			http.Error(w, "agent unreachable", http.StatusBadGateway)
		},
	}
	return g
}

func (g *gate) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	ip := clientIP(r)
	h := w.Header()
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")

	if !g.allowed(ip) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	if g.fails.blocked(ip) {
		h.Set("Retry-After", "600")
		http.Error(w, "too many failed logins", http.StatusTooManyRequests)
		return
	}
	if !g.authorized(r) {
		if g.fails.fail(ip) {
			log.Printf("mvgate: %s blocked for 10 minutes after repeated failed logins", ip)
		}
		h.Set("WWW-Authenticate", `Basic realm="mvgate", charset="UTF-8"`)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		h.Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !routes[r.URL.Path] {
		http.NotFound(w, r)
		return
	}
	if r.URL.Path == "/stream" {
		select {
		case g.streams <- struct{}{}:
			defer func() { <-g.streams }()
		default:
			http.Error(w, "too many open streams", http.StatusServiceUnavailable)
			return
		}
		log.Printf("mvgate: stream opened by %s", ip)
		defer log.Printf("mvgate: stream closed by %s", ip)
	}
	g.proxy.ServeHTTP(w, r)
}

func (g *gate) allowed(ip net.IP) bool {
	if len(g.cfg.Allow) == 0 {
		return true
	}
	if ip == nil {
		return false
	}
	for _, n := range g.cfg.Allow {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

// authorized accepts Basic auth (any user name, password = token) or a Bearer token.
func (g *gate) authorized(r *http.Request) bool {
	var got string
	if _, pw, ok := r.BasicAuth(); ok {
		got = pw
	} else if a := r.Header.Get("Authorization"); len(a) > 7 && strings.EqualFold(a[:7], "bearer ") {
		got = strings.TrimSpace(a[7:])
	} else {
		return false
	}
	h := sha256.Sum256([]byte(got))
	return subtle.ConstantTimeCompare(h[:], g.tokenH[:]) == 1
}

// clientIP is the TCP peer. Forwarded headers are ignored on purpose: the
// allow list and the login limiter must not be fooled by a client header.
func clientIP(r *http.Request) net.IP {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	return net.ParseIP(host)
}

// failLimiter blocks an IP after max failed logins within window, for block.
type failLimiter struct {
	mu     sync.Mutex
	max    int
	window time.Duration
	block  time.Duration
	now    func() time.Time
	ips    map[string]*failEntry
}

type failEntry struct {
	first, until time.Time
	n            int
}

func newFailLimiter(max int, window, block time.Duration) *failLimiter {
	return &failLimiter{max: max, window: window, block: block, now: time.Now, ips: map[string]*failEntry{}}
}

func (l *failLimiter) blocked(ip net.IP) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	e := l.ips[ip.String()]
	return e != nil && l.now().Before(e.until)
}

// fail records a failed login and reports whether the IP just got blocked.
func (l *failLimiter) fail(ip net.IP) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	if len(l.ips) > 10000 {
		for k, e := range l.ips {
			if now.Sub(e.first) > l.window && now.After(e.until) {
				delete(l.ips, k)
			}
		}
	}
	k := ip.String()
	e := l.ips[k]
	if e == nil || now.Sub(e.first) > l.window {
		e = &failEntry{first: now}
		l.ips[k] = e
	}
	e.n++
	if e.n >= l.max {
		e.until = now.Add(l.block)
		e.n, e.first = 0, now
		return true
	}
	return false
}

// healthcheck asks the gate itself for /healthz with the token.
func healthcheck(cfg config, cfgErr error) int {
	if cfgErr != nil {
		fmt.Fprintln(os.Stderr, cfgErr)
		return 1
	}
	_, port, err := net.SplitHostPort(cfg.Addr)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	scheme := "http"
	tr := &http.Transport{}
	if cfg.TLSCert != "" {
		scheme = "https"
		// the certificate is issued for the public name, not for 127.0.0.1
		tr.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}
	}
	req, _ := http.NewRequest(http.MethodGet, scheme+"://127.0.0.1:"+port+"/healthz", nil)
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	resp, err := (&http.Client{Transport: tr, Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		fmt.Fprintln(os.Stderr, "healthz:", resp.Status)
		return 1
	}
	return 0
}
