// mvgate is the only published port of the MapViewer3D live data on a Dune
// Docker host. It speaks securelink (TLS 1.3, pinned key, token proof bound to
// the TLS session) and forwards three read-only routes to mvagent, which has
// no login and sits on an internal network.
//
//	mvgate                       serve
//	mvgate -pair host[:port]     print the pairing code for MapViewer3D
//	mvgate -pin                  print the key fingerprint (no secret) and exit
//	mvgate -rotate-token         new token (old pairing codes stop working after a restart)
//	mvgate -healthcheck          container health check
package main

import (
	"context"
	"crypto/x509"
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
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"mvgate/securelink"
)

type config struct {
	Addr       string
	Upstream   *url.URL
	State      string
	Token      string
	Allow      []*net.IPNet
	MaxStreams int
}

func main() {
	pair := flag.String("pair", "", "print the pairing code for this public host[:port] and exit")
	pinOnly := flag.Bool("pin", false, "print the key fingerprint (sha256/…, not secret) and exit")
	rotate := flag.Bool("rotate-token", false, "create a new token and exit (restart mvgate afterwards)")
	health := flag.Bool("healthcheck", false, "check the local gate and exit")
	flag.Parse()
	log.SetFlags(log.LstdFlags | log.LUTC)

	cfg, err := loadConfig(os.Getenv)
	if err != nil {
		log.Fatal(err)
	}
	if *rotate {
		if os.Getenv("MV_GATE_TOKEN") != "" {
			log.Fatal("MV_GATE_TOKEN is set in the environment: change it there")
		}
		p := filepath.Join(cfg.State, "token")
		if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
			log.Fatal(err)
		}
		if _, err := securelink.LoadOrCreateToken(p); err != nil {
			log.Fatal(err)
		}
		fmt.Println("New token written. Restart mvgate, then create a new pairing code (-pair).")
		return
	}
	id, err := securelink.LoadOrCreateIdentity(cfg.State)
	if err != nil {
		log.Fatal(err)
	}
	if *pinOnly {
		fmt.Println(securelink.Pin(id.Leaf))
		return
	}
	if cfg.Token == "" {
		if cfg.Token, err = securelink.LoadOrCreateToken(filepath.Join(cfg.State, "token")); err != nil {
			log.Fatal(err)
		}
	}
	if *pair != "" {
		os.Exit(printPairing(*pair, cfg, id.Leaf))
	}
	if *health {
		os.Exit(healthcheck(cfg, securelink.Pin(id.Leaf)))
	}

	inner, err := net.Listen("tcp", cfg.Addr)
	if err != nil {
		log.Fatal(err)
	}
	fails := newFailLimiter(10, time.Minute, 10*time.Minute)
	ln, err := securelink.Listen(inner, securelink.ServerConfig{
		Cert:    id,
		Token:   cfg.Token,
		Allow:   cfg.allowed,
		Blocked: fails.blocked,
		OnFail: func(ip net.IP, err error) {
			if fails.fail(ip) {
				log.Printf("mvgate: %s blocked for 10 minutes after repeated failed connections (last: %v)", ip, err)
			}
		},
	})
	if err != nil {
		log.Fatal(err)
	}
	srv := &http.Server{
		Handler:           newHandler(cfg),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
		MaxHeaderBytes:    16 << 10,
		ErrorLog:          log.New(os.Stderr, "mvgate http: ", log.LstdFlags|log.LUTC),
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		srv.Shutdown(sctx)
	}()
	log.Printf("mvgate: securelink v%d (TLS 1.3, pinned key) on %s -> %s; key %s; allow list %d entries; max streams %d",
		securelink.Version, cfg.Addr, cfg.Upstream, securelink.Pin(id.Leaf), len(cfg.Allow), cfg.MaxStreams)
	log.Printf("mvgate: pairing code: docker compose -f docker-compose.mapviewer-live.yml exec mvgate mvgate -pair <public-host>")
	if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) && ctx.Err() == nil {
		log.Fatal(err)
	}
}

func loadConfig(env func(string) string) (config, error) {
	cfg := config{
		Addr:       envOr(env, "MV_GATE_ADDR", ":8797"),
		State:      envOr(env, "MV_GATE_STATE", "/data"),
		Token:      strings.TrimSpace(env("MV_GATE_TOKEN")),
		MaxStreams: 8,
	}
	if cfg.Token != "" {
		if err := securelink.CheckToken(cfg.Token); err != nil {
			return cfg, fmt.Errorf("MV_GATE_TOKEN: %v (leave it empty and mvgate creates one)", err)
		}
	}
	u, err := url.Parse(envOr(env, "MV_GATE_UPSTREAM", "http://mvagent:8796"))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return cfg, errors.New("MV_GATE_UPSTREAM: expected http://host:port")
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
	return cfg, nil
}

func envOr(env func(string) string, k, def string) string {
	if v := env(k); v != "" {
		return v
	}
	return def
}

func (c config) allowed(ip net.IP) bool {
	if len(c.Allow) == 0 {
		return true
	}
	if ip == nil {
		return false
	}
	if ip.IsLoopback() {
		return true // the container's own health check
	}
	for _, n := range c.Allow {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

// routes the gate forwards; everything else is 404.
var routes = map[string]bool{"/healthz": true, "/stream": true, "/api/objects": true}

func newHandler(cfg config) http.Handler {
	streams := make(chan struct{}, cfg.MaxStreams)
	proxy := &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(cfg.Upstream)
			r.Out.Header = http.Header{"Accept": r.In.Header["Accept"]}
		},
		FlushInterval: -1, // server-sent events: pass every write on at once
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			log.Printf("mvgate: agent unreachable: %v", err)
			http.Error(w, "agent unreachable", http.StatusBadGateway)
		},
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Cache-Control", "no-store")
		h.Set("X-Content-Type-Options", "nosniff")
		if r.TLS == nil {
			http.Error(w, "forbidden", http.StatusForbidden) // cannot happen behind securelink
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
			case streams <- struct{}{}:
				defer func() { <-streams }()
			default:
				http.Error(w, "too many open streams", http.StatusServiceUnavailable)
				return
			}
			log.Printf("mvgate: stream opened by %s", r.RemoteAddr)
			defer log.Printf("mvgate: stream closed by %s", r.RemoteAddr)
		}
		proxy.ServeHTTP(w, r)
	})
}

// printPairing prints the pairing code for the public address of this gate.
func printPairing(host string, cfg config, leaf *x509.Certificate) int {
	addr := host
	if _, _, err := net.SplitHostPort(host); err != nil {
		_, port, err := net.SplitHostPort(cfg.Addr)
		if err != nil {
			port = "8797"
		}
		if p := os.Getenv("MV_GATE_PUBLIC_PORT"); p != "" {
			port = p
		}
		addr = net.JoinHostPort(strings.Trim(host, "[]"), port)
	}
	p := securelink.Pairing{Addr: addr, Pin: securelink.Pin(leaf), Token: cfg.Token}
	fmt.Fprintln(os.Stderr, "Pairing code for MapViewer3D (contains the secret token – handle it like a password,")
	fmt.Fprintln(os.Stderr, "send it only over a trusted channel). Key fingerprint:", p.Pin)
	fmt.Println(p.Encode())
	return 0
}

// healthcheck connects to the local gate through securelink and asks /healthz.
func healthcheck(cfg config, pin string) int {
	_, port, err := net.SplitHostPort(cfg.Addr)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	p := securelink.Pairing{Addr: net.JoinHostPort("127.0.0.1", port), Pin: pin, Token: cfg.Token}
	c := &http.Client{Transport: securelink.Transport(p), Timeout: 5 * time.Second}
	resp, err := c.Get("https://mvgate/healthz")
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

// failLimiter blocks an IP after max failed connections within window, for block.
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
	if ip == nil || ip.IsLoopback() {
		return false
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	e := l.ips[ip.String()]
	return e != nil && l.now().Before(e.until)
}

// fail records a failure and reports whether the IP just got blocked.
func (l *failLimiter) fail(ip net.IP) bool {
	if ip == nil || ip.IsLoopback() {
		return false
	}
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
