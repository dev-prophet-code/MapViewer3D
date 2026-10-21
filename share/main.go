// mvshare is the share gateway of the MapViewer3D addon: it lets the administrator of a Dune Docker
// server hand out links to the 3D map.
//
//	https://<host>/s/<token>/        the viewer, for everybody who has the link
//	https://<host>/share-admin/...   create / list / revoke links (admin secret)
//
// Design (see SECURITY.md):
//
//   - A link token is 256 random bits. Only its SHA-256 is stored. There is nothing to forge or to
//     derive; a revoked or expired token stops working at once, also for streams that are open.
//
//   - Visitors never get an API key. The gateway holds ONE read-only Console API key (the "service key",
//     a file on the host) and uses it itself for a short allow list of GET routes. Every answer is
//     rebuilt from an allow list of fields (no account ids, no storage contents, no settings files).
//
//   - No route reaches the Console's login, settings, setup, write or admin routes; the Console's session
//     cookie is never used. The admin secret is a separate secret that is good for nothing but this API.
//
//   - Failed token / secret attempts are counted per client address; requests are rate limited and
//     answers are cached, so many visitors put almost no load on the Console.
//
//     mvshare                  serve
//     mvshare -admin-key       print the admin secret
//     mvshare -set-key         read the service key (dak_…) from stdin and store it
//     mvshare -healthcheck     container health check
package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode"
)

const version = "1"

type config struct {
	Addr         string
	Upstream     *url.URL
	State        string
	KeyFile      string
	Web          string
	AdminOrigins []string
	Cert, Key    string
	TrustProxy   bool
	AllowPlain   bool
}

func main() {
	showAdmin := flag.Bool("admin-key", false, "print the admin secret and exit")
	setKey := flag.Bool("set-key", false, "read the service key from stdin, store it and exit")
	health := flag.Bool("healthcheck", false, "check the local gateway and exit")
	flag.Parse()
	log.SetFlags(log.LstdFlags | log.LUTC)
	cfg, err := loadConfig(os.Getenv)
	if err != nil {
		log.Fatal(err)
	}
	if *health {
		os.Exit(healthcheck(cfg))
	}
	if *setKey {
		b, _ := io.ReadAll(io.LimitReader(os.Stdin, 4096))
		k := strings.TrimSpace(string(b))
		if !keyPattern.MatchString(k) {
			log.Fatal("that is not an API key (dak_…)")
		}
		if err := os.WriteFile(cfg.KeyFile, []byte(k+"\n"), 0o600); err != nil {
			log.Fatal(err)
		}
		fmt.Println("service key stored")
		return
	}
	secret, created, err := loadOrCreateAdminSecret(cfg.State)
	if err != nil {
		log.Fatal(err)
	}
	if *showAdmin {
		fmt.Println(secret)
		return
	}
	gw, err := newGateway(cfg, secret)
	if err != nil {
		log.Fatal(err)
	}
	if created {
		log.Printf("mvshare: admin secret created; show it with: mvshare -admin-key")
	}
	if gw.serviceKey() == "" {
		log.Printf("mvshare: no service key yet – store one with: mvshare -set-key  (a read-only Console API key)")
	}
	srv := &http.Server{
		Handler:           gw,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		IdleTimeout:       2 * time.Minute,
		MaxHeaderBytes:    16 << 10,
		ErrorLog:          log.New(os.Stderr, "mvshare http: ", log.LstdFlags|log.LUTC),
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		srv.Shutdown(sctx)
	}()
	ln, err := net.Listen("tcp", cfg.Addr)
	if err != nil {
		log.Fatal(err)
	}
	scheme := "http"
	if cfg.Cert != "" {
		scheme = "https"
		pair, err := tls.LoadX509KeyPair(cfg.Cert, cfg.Key)
		if err != nil {
			log.Fatal(err)
		}
		ln = tls.NewListener(ln, &tls.Config{Certificates: []tls.Certificate{pair}, MinVersion: tls.VersionTLS12, NextProtos: []string{"http/1.1"}})
	}
	log.Printf("mvshare: %s://%s -> %s; links: %d", scheme, cfg.Addr, cfg.Upstream, len(gw.st.list()))
	if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) && ctx.Err() == nil {
		log.Fatal(err)
	}
}

var keyPattern = regexp.MustCompile(`^dak_[A-Za-z0-9_-]{8,200}$`)

func loadConfig(env func(string) string) (config, error) {
	or := func(k, d string) string {
		if v := env(k); v != "" {
			return v
		}
		return d
	}
	cfg := config{
		Addr:       or("MV_SHARE_ADDR", "127.0.0.1:8798"),
		State:      or("MV_SHARE_STATE", "/data"),
		Web:        or("MV_SHARE_WEB", "/web"),
		Cert:       env("MV_SHARE_CERT"),
		Key:        env("MV_SHARE_CERT_KEY"),
		TrustProxy: env("MV_SHARE_TRUST_PROXY") == "true",
		AllowPlain: env("MV_SHARE_ALLOW_PLAIN") == "true",
	}
	cfg.KeyFile = or("MV_SHARE_KEY_FILE", filepath.Join(cfg.State, "service-key"))
	u, err := url.Parse(or("MV_SHARE_UPSTREAM", "http://127.0.0.1:8088"))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || (u.Path != "" && u.Path != "/") {
		return cfg, errors.New("MV_SHARE_UPSTREAM: expected http://host:port")
	}
	if u.Scheme == "http" && !isLoopbackHost(u.Hostname()) {
		return cfg, errors.New("MV_SHARE_UPSTREAM: plain http is only accepted for the loopback address (the service key travels there)")
	}
	cfg.Upstream = u
	for _, o := range strings.FieldsFunc(env("MV_SHARE_ADMIN_ORIGINS"), func(r rune) bool { return r == ',' || r == ' ' }) {
		ou, err := url.Parse(o)
		if err != nil || (ou.Scheme != "https" && ou.Scheme != "http") || ou.Host == "" || ou.Path != "" {
			return cfg, fmt.Errorf("MV_SHARE_ADMIN_ORIGINS: %q is not an origin (https://host[:port])", o)
		}
		cfg.AdminOrigins = append(cfg.AdminOrigins, ou.Scheme+"://"+ou.Host)
	}
	if (cfg.Cert == "") != (cfg.Key == "") {
		return cfg, errors.New("MV_SHARE_CERT and MV_SHARE_CERT_KEY belong together")
	}
	host, _, err := net.SplitHostPort(cfg.Addr)
	if err != nil {
		return cfg, errors.New("MV_SHARE_ADDR: expected host:port")
	}
	if cfg.Cert == "" && !isLoopbackHost(host) && !cfg.AllowPlain {
		return cfg, errors.New("MV_SHARE_ADDR is not a loopback address and no certificate is set: links would travel unencrypted. " +
			"Put an HTTPS reverse proxy in front (keep 127.0.0.1), set MV_SHARE_CERT / MV_SHARE_CERT_KEY, or MV_SHARE_ALLOW_PLAIN=true if you know why")
	}
	return cfg, nil
}

func isLoopbackHost(h string) bool {
	if h == "localhost" {
		return true
	}
	ip := net.ParseIP(h)
	return ip != nil && ip.IsLoopback()
}

func healthcheck(cfg config) int {
	host, port, _ := net.SplitHostPort(cfg.Addr)
	if host == "" || host == "0.0.0.0" {
		host = "127.0.0.1"
	}
	scheme := "http"
	if cfg.Cert != "" {
		scheme = "https"
	}
	c := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}}
	resp, err := c.Get(scheme + "://" + net.JoinHostPort(host, port) + "/mvshare")
	if err != nil {
		return 1
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}

const adminPrefix = "mva_"

func loadOrCreateAdminSecret(dir string) (string, bool, error) {
	p := filepath.Join(dir, "admin-key")
	if b, err := os.ReadFile(p); err == nil {
		s := strings.TrimSpace(string(b))
		if regexp.MustCompile(`^mva_[A-Za-z0-9_-]{43}$`).MatchString(s) {
			return s, false, nil
		}
		return "", false, errors.New(p + " is not valid; delete it to create a new admin secret")
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", false, err
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", false, err
	}
	s := adminPrefix + base64.RawURLEncoding.EncodeToString(raw)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", false, err
	}
	return s, true, os.WriteFile(p, []byte(s+"\n"), 0o600)
}

// ---------------------------------------------------------------- gateway

type gateway struct {
	cfg          config
	st           *store
	adminDigest  [32]byte
	client       *http.Client
	streamClient *http.Client
	hub          *hub
	fails        *failLimiter
	rate         *rateLimiter
	sem          chan struct{}

	keyMu    sync.Mutex
	keyVal   string
	keyStamp time.Time

	cacheMu sync.Mutex
	cache   map[string]*centry

	auth authState
}

func newGateway(cfg config, adminSecret string) (*gateway, error) {
	st, err := newStore(cfg.State)
	if err != nil {
		return nil, err
	}
	g := &gateway{
		cfg: cfg, st: st, adminDigest: sha256.Sum256([]byte(adminSecret)),
		client:       &http.Client{Timeout: 20 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
		streamClient: &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
		fails:        newFailLimiter(15, time.Minute, 10*time.Minute),
		rate:         newRateLimiter(900, time.Minute),
		sem:          make(chan struct{}, 48),
		cache:        map[string]*centry{},
	}
	g.auth.keys = map[string]capEntry{}
	g.hub = newHub(g)
	return g, nil
}

// serviceKey is read from the key file (re-read when it changes). Never logged, never sent to a visitor.
func (g *gateway) serviceKey() string {
	g.keyMu.Lock()
	defer g.keyMu.Unlock()
	if time.Since(g.keyStamp) < 30*time.Second && g.keyVal != "" {
		return g.keyVal
	}
	g.keyStamp = time.Now()
	k := ""
	if b, err := os.ReadFile(g.cfg.KeyFile); err == nil {
		k = strings.TrimSpace(string(b))
	}
	if !keyPattern.MatchString(k) {
		k = ""
	}
	g.keyVal = k
	return k
}

func (g *gateway) upstreamRequest(ctx context.Context, p, rawQuery string) (*http.Request, error) {
	return g.upstreamRequestKey(ctx, g.serviceKey(), p, rawQuery)
}

func (g *gateway) upstreamRequestKey(ctx context.Context, key, p, rawQuery string) (*http.Request, error) {
	if key == "" {
		return nil, errors.New("no service key")
	}
	u := *g.cfg.Upstream
	u.Path, u.RawQuery = p, rawQuery
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "mvshare/"+version)
	return req, nil
}

// clientIP is the address the limits count. A reverse proxy on the same host (the usual setup: nginx or
// Caddy forwarding to 127.0.0.1) would otherwise make every visitor look like 127.0.0.1, so one
// scanner could lock out everybody; therefore X-Forwarded-For (its last entry, the one the proxy
// appended) is used when the peer is a loopback address, or when MV_SHARE_TRUST_PROXY=true names a
// proxy elsewhere.
func (g *gateway) clientIP(r *http.Request) net.IP {
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	peer := net.ParseIP(host)
	if g.cfg.TrustProxy || (peer != nil && peer.IsLoopback()) {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			if ip := net.ParseIP(strings.TrimSpace(parts[len(parts)-1])); ip != nil {
				return ip
			}
		}
	}
	return peer
}

func jsonError(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(obj{"error": msg})
}

func (g *gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("X-Frame-Options", "DENY")
	h.Set("Cross-Origin-Opener-Policy", "same-origin")
	h.Set("Cross-Origin-Resource-Policy", "same-origin")
	h.Set("Strict-Transport-Security", "max-age=31536000")
	p := r.URL.Path
	switch {
	case p == "/mvshare":
		// public identification: the addon asks it (without any credential) before it sends the
		// administrator's key to an address it only guessed
		h.Set("Content-Type", "application/json")
		h.Set("Cache-Control", "no-store")
		h.Set("Access-Control-Allow-Origin", "*")
		fmt.Fprintf(w, `{"mapviewer-share":%s}`, version)
	case strings.HasPrefix(p, "/s/"):
		g.share(w, r)
	case strings.HasPrefix(p, "/share-admin/"):
		g.admin(w, r)
	default:
		http.NotFound(w, r)
	}
}

// ---------------------------------------------------------------- visitors

// Content Security Policy of the viewer page. The page has no inline script except the import map; its
// hash is computed from the file the gateway serves, so nothing else inline can run.
func cspFor(html []byte) string {
	script := "'self'"
	for _, m := range inlineScript.FindAllSubmatch(html, -1) {
		if srcAttr.Match(m[1]) || len(bytes.TrimSpace(m[2])) == 0 {
			continue // an external file: covered by 'self'
		}
		h := sha256.Sum256(m[2])
		script += " 'sha256-" + base64.StdEncoding.EncodeToString(h[:]) + "'"
	}
	return "default-src 'none'; script-src " + script + "; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
		"font-src 'self'; connect-src 'self' https://raw.githubusercontent.com https://cdn.jsdelivr.net; " +
		"base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
}

var (
	inlineScript = regexp.MustCompile(`(?is)<script((?:\s[^>]*)?)>(.*?)</script>`)
	srcAttr      = regexp.MustCompile(`(?i)\ssrc\s*=`)
)

func (g *gateway) share(w http.ResponseWriter, r *http.Request) {
	ip := g.clientIP(r)
	if g.fails.blocked(ip) {
		w.Header().Set("Retry-After", "600")
		http.Error(w, "too many attempts", http.StatusTooManyRequests)
		return
	}
	if !g.rate.allow(ip) {
		w.Header().Set("Retry-After", "30")
		http.Error(w, "slow down", http.StatusTooManyRequests)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, "/s/")
	token, sub, hasSlash := strings.Cut(rest, "/")
	l, ok := g.st.lookup(token)
	if !ok {
		g.fails.fail(ip) // unknown, revoked and expired look the same
		http.NotFound(w, r)
		return
	}
	if !hasSlash {
		http.Redirect(w, r, "/s/"+token+"/", http.StatusPermanentRedirect)
		return
	}
	if strings.Contains(sub, "..") || strings.Contains(sub, "//") || strings.Contains(sub, `\`) || strings.ContainsRune(sub, 0) {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if strings.HasPrefix(sub, "api/") || strings.HasPrefix(sub, "images/") {
		g.api(w, r, "/"+sub, l)
		return
	}
	g.static(w, r, sub)
}

func (g *gateway) static(w http.ResponseWriter, r *http.Request, sub string) {
	if sub == "" {
		sub = "index.html"
	}
	clean := path.Clean("/" + sub)[1:]
	for _, seg := range strings.Split(clean, "/") {
		if strings.HasPrefix(seg, ".") {
			http.NotFound(w, r)
			return
		}
	}
	f, err := os.Open(filepath.Join(g.cfg.Web, filepath.FromSlash(clean)))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil || !fi.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}
	h := w.Header()
	h.Set("Content-Type", mime.TypeByExtension(strings.ToLower(filepath.Ext(clean))))
	if clean == "index.html" {
		html, err := io.ReadAll(io.LimitReader(f, 4<<20))
		if err != nil {
			http.Error(w, "unreadable", http.StatusInternalServerError)
			return
		}
		h.Set("Content-Security-Policy", cspFor(html))
		h.Set("Cache-Control", "no-store")
		if h.Get("Content-Type") == "" {
			h.Set("Content-Type", "text/html; charset=utf-8")
		}
		http.ServeContent(w, r, clean, fi.ModTime(), bytes.NewReader(html))
		return
	} else {
		h.Set("Cache-Control", "private, max-age=600")
	}
	if h.Get("Content-Type") == "" {
		h.Set("Content-Type", "application/octet-stream")
	}
	http.ServeContent(w, r, clean, fi.ModTime(), f)
}

type route struct {
	re      *regexp.Regexp
	ttl     time.Duration
	query   []string // allowed query parameters
	option  func(l link) bool
	clean   func(body []byte, o linkOptions) ([]byte, error)
	offBody string // answer when the option is off ("" = 403)
}

func optsOf(l link) linkOptions {
	return linkOptions{Players: l.Players, Bases: l.Bases, Realtime: l.Realtime}
}

var routes = []route{
	{re: regexp.MustCompile(`^/api/map/partitions$`), ttl: 20 * time.Second, clean: func(b []byte, _ linkOptions) ([]byte, error) { return sanitizePartitions(b) }},
	{re: regexp.MustCompile(`^/api/map/status$`), ttl: 20 * time.Second, clean: func(b []byte, _ linkOptions) ([]byte, error) { return sanitizeStatus(b) }},
	{re: regexp.MustCompile(`^/api/map/markers$`), ttl: 20 * time.Second, query: []string{"map"}, clean: func(b []byte, _ linkOptions) ([]byte, error) { return sanitizeMarkers(b) }},
	{re: regexp.MustCompile(`^/api/map/overlays$`), ttl: 5 * time.Second, query: []string{"map"}, clean: sanitizeRows},
	{re: regexp.MustCompile(`^/api/map/poi$`), ttl: 60 * time.Second, query: []string{"map"}, clean: sanitizeRows},
	{re: regexp.MustCompile(`^/api/map/spice$`), ttl: 30 * time.Second, query: []string{"map", "partitionId"}, clean: sanitizeRows},
	{re: regexp.MustCompile(`^/api/map/players$`), ttl: 2 * time.Second, query: []string{"map"}, clean: sanitizeRows,
		option: func(l link) bool { return l.Players }, offBody: `{"rows":[]}`},
	{re: regexp.MustCompile(`^/api/maps/user-settings/values$`), ttl: 5 * time.Minute, query: []string{"scope", "map", "partitionId"},
		clean: func(b []byte, _ linkOptions) ([]byte, error) { return sanitizeSettings(b) }},
	{re: regexp.MustCompile(`^/api/bases/[0-9]{1,12}/export$`), ttl: 60 * time.Second, option: func(l link) bool { return l.Bases },
		clean: func(b []byte, _ linkOptions) ([]byte, error) { return sanitizeBase(b) }},
	{re: regexp.MustCompile(`^/api/realtime/objects$`), ttl: 2 * time.Second, option: func(l link) bool { return l.Realtime },
		clean: func(b []byte, _ linkOptions) ([]byte, error) { return sanitizeRealtimeObjects(b) }},
	{re: regexp.MustCompile(`^/api/realtime/healthz$`), ttl: 10 * time.Second, option: func(l link) bool { return l.Realtime },
		clean: func(b []byte, _ linkOptions) ([]byte, error) { return sanitizeRealtimeHealth(b) }},
}

func cleanQuery(v url.Values, allowed []string) (string, bool) {
	out := url.Values{}
	for k, vals := range v {
		ok := false
		for _, a := range allowed {
			ok = ok || a == k
		}
		if !ok || len(vals) != 1 {
			return "", false
		}
		val := vals[0]
		switch k {
		case "map":
			ok = mapName.MatchString(val)
		case "partitionId":
			ok = digits.MatchString(val)
		case "scope":
			ok = settingScope.MatchString(val)
		}
		if !ok {
			return "", false
		}
		out.Set(k, val)
	}
	return out.Encode(), true
}

func (g *gateway) api(w http.ResponseWriter, r *http.Request, p string, l link) {
	h := w.Header()
	if strings.HasPrefix(p, "/images/maps/") {
		g.image(w, r, p)
		return
	}
	if p == "/api/link" { // what this link offers; nothing secret
		h.Set("Content-Type", "application/json")
		h.Set("Cache-Control", "no-store")
		json.NewEncoder(w).Encode(obj{"players": l.Players, "bases": l.Bases, "realtime": l.Realtime, "expires": l.Expires})
		return
	}
	if p == "/api/realtime/stream" {
		if !l.Realtime {
			jsonError(w, http.StatusForbidden, "not enabled for this link")
			return
		}
		g.hub.serve(w, r, func() bool { return g.st.stillActive(l.Hash) })
		return
	}
	for _, rt := range routes {
		if !rt.re.MatchString(p) {
			continue
		}
		if rt.option != nil && !rt.option(l) {
			h.Set("Cache-Control", "no-store")
			if rt.offBody != "" {
				h.Set("Content-Type", "application/json")
				io.WriteString(w, rt.offBody)
				return
			}
			code := http.StatusForbidden
			if strings.HasPrefix(p, "/api/bases/") {
				code = http.StatusNotFound
			}
			jsonError(w, code, "not enabled for this link")
			return
		}
		q, ok := cleanQuery(r.URL.Query(), rt.query)
		if !ok {
			jsonError(w, http.StatusBadRequest, "bad query")
			return
		}
		o := optsOf(l)
		status, body := g.cached(fmt.Sprintf("%s?%s|%v", p, q, l.Players), rt.ttl, func() (int, []byte) {
			return g.fetchJSON(context.WithoutCancel(r.Context()), p, q, o, rt.clean)
		})
		h.Set("Content-Type", "application/json")
		h.Set("Cache-Control", "no-store")
		w.WriteHeader(status)
		if r.Method != http.MethodHead {
			w.Write(body)
		}
		return
	}
	jsonError(w, http.StatusNotFound, "not found")
}

// fetchJSON asks the Console with the service key and returns a status and a cleaned body. Error
// bodies of the Console are never passed on.
func (g *gateway) fetchJSON(ctx context.Context, p, q string, o linkOptions, clean func([]byte, linkOptions) ([]byte, error)) (int, []byte) {
	select {
	case g.sem <- struct{}{}:
		defer func() { <-g.sem }()
	case <-ctx.Done():
		return http.StatusServiceUnavailable, errBody("cancelled")
	}
	req, err := g.upstreamRequest(ctx, p, q)
	if err != nil {
		return http.StatusServiceUnavailable, errBody("not configured")
	}
	resp, err := g.client.Do(req)
	if err != nil {
		return http.StatusBadGateway, errBody("console unreachable")
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		return http.StatusBadGateway, errBody("console unreachable")
	}
	switch {
	case resp.StatusCode == http.StatusOK:
		out, err := clean(body, o)
		if err != nil {
			return http.StatusBadGateway, errBody("unexpected answer")
		}
		return http.StatusOK, out
	case resp.StatusCode == http.StatusUnauthorized:
		return http.StatusServiceUnavailable, errBody("the gateway's key is not accepted") // not the visitor's problem
	case resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusBadRequest:
		return resp.StatusCode, errBody("not available")
	}
	return http.StatusBadGateway, errBody("console error")
}

func errBody(msg string) []byte {
	b, _ := json.Marshal(obj{"error": msg})
	return b
}

func (g *gateway) image(w http.ResponseWriter, r *http.Request, p string) {
	name := strings.TrimPrefix(p, "/images/maps/")
	if !imageName.MatchString(name) {
		http.NotFound(w, r)
		return
	}
	select {
	case g.sem <- struct{}{}:
		defer func() { <-g.sem }()
	case <-r.Context().Done():
		return
	}
	req, err := g.upstreamRequest(r.Context(), p, "")
	if err != nil {
		http.Error(w, "not configured", http.StatusServiceUnavailable)
		return
	}
	req.Header.Set("Accept", "image/*")
	resp, err := g.client.Do(req)
	if err != nil {
		http.Error(w, "console unreachable", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	ct := resp.Header.Get("Content-Type")
	if resp.StatusCode != http.StatusOK || !strings.HasPrefix(ct, "image/") {
		http.NotFound(w, r)
		return
	}
	h := w.Header()
	h.Set("Content-Type", ct)
	h.Set("Content-Security-Policy", "sandbox; default-src 'none'")
	h.Set("Cache-Control", "private, max-age=3600")
	io.Copy(w, io.LimitReader(resp.Body, 8<<20))
}

// ---------------------------------------------------------------- cache

type centry struct {
	ready  chan struct{}
	at     time.Time
	status int
	body   []byte
}

// cached returns a fresh answer or runs fetch once for everybody who asks at the same time.
func (g *gateway) cached(key string, ttl time.Duration, fetch func() (int, []byte)) (int, []byte) {
	g.cacheMu.Lock()
	e := g.cache[key]
	if e != nil {
		select {
		case <-e.ready:
			age := time.Since(e.at)
			if age < ttl || (e.status >= 500 && age < 2*time.Second) {
				g.cacheMu.Unlock()
				return e.status, e.body
			}
		default:
			g.cacheMu.Unlock()
			<-e.ready
			return e.status, e.body
		}
	}
	if len(g.cache) > 512 {
		g.cache = map[string]*centry{}
	}
	e = &centry{ready: make(chan struct{})}
	g.cache[key] = e
	g.cacheMu.Unlock()
	e.status, e.body = fetch()
	e.at = time.Now()
	close(e.ready)
	return e.status, e.body
}

// ---------------------------------------------------------------- limits

type failLimiter struct {
	mu     sync.Mutex
	max    int
	window time.Duration
	block  time.Duration
	ips    map[string]*failEntry
}

type failEntry struct {
	first, until time.Time
	n            int
}

func newFailLimiter(max int, window, block time.Duration) *failLimiter {
	return &failLimiter{max: max, window: window, block: block, ips: map[string]*failEntry{}}
}

func (l *failLimiter) blocked(ip net.IP) bool {
	if ip == nil {
		return false
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	e := l.ips[ip.String()]
	return e != nil && time.Now().Before(e.until)
}

func (l *failLimiter) fail(ip net.IP) {
	if ip == nil {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
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
	if e.n++; e.n >= l.max {
		e.until, e.n, e.first = now.Add(l.block), 0, now
		log.Printf("mvshare: %s blocked for %s after repeated invalid tokens/secrets", ip, l.block)
	}
}

type rateLimiter struct {
	mu     sync.Mutex
	max    int
	window time.Duration
	ips    map[string]*failEntry
}

func newRateLimiter(max int, window time.Duration) *rateLimiter {
	return &rateLimiter{max: max, window: window, ips: map[string]*failEntry{}}
}

func (l *rateLimiter) allow(ip net.IP) bool {
	if ip == nil {
		return true
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	if len(l.ips) > 10000 {
		l.ips = map[string]*failEntry{}
	}
	k := ip.String()
	e := l.ips[k]
	if e == nil || now.Sub(e.first) > l.window {
		e = &failEntry{first: now}
		l.ips[k] = e
	}
	e.n++
	return e.n <= l.max
}

// ---------------------------------------------------------------- admin

func (g *gateway) corsAdmin(w http.ResponseWriter, r *http.Request) bool {
	o := r.Header.Get("Origin")
	h := w.Header()
	h.Set("Cache-Control", "no-store")
	h.Add("Vary", "Origin")
	if o == "" {
		return true // not a browser (curl, script)
	}
	for _, a := range g.cfg.AdminOrigins {
		if a == o {
			h.Set("Access-Control-Allow-Origin", o)
			h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			h.Set("Access-Control-Allow-Methods", "GET, POST, DELETE")
			h.Set("Access-Control-Max-Age", "600")
			if r.Header.Get("Access-Control-Request-Private-Network") == "true" {
				h.Set("Access-Control-Allow-Private-Network", "true") // an https console page reaching a gateway on this machine (tunnel)
			}
			return true
		}
	}
	return false
}

type createReq struct {
	Label    string `json:"label"`
	Never    bool   `json:"never"`
	Seconds  int64  `json:"seconds"`
	Players  bool   `json:"players"`
	Bases    bool   `json:"bases"`
	Realtime bool   `json:"realtime"`
}

func cleanLabel(s string) string {
	var b strings.Builder
	n := 0
	for _, r := range strings.TrimSpace(s) {
		if unicode.IsControl(r) || r == '<' || r == '>' {
			continue
		}
		if n++; n > 60 {
			break
		}
		b.WriteRune(r)
	}
	return b.String()
}

func (g *gateway) admin(w http.ResponseWriter, r *http.Request) {
	ip := g.clientIP(r)
	if !g.corsAdmin(w, r) {
		jsonError(w, http.StatusForbidden, "origin not allowed (MV_SHARE_ADMIN_ORIGINS)")
		return
	}
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if g.fails.blocked(ip) {
		w.Header().Set("Retry-After", "600")
		jsonError(w, http.StatusTooManyRequests, "too many attempts")
		return
	}
	p, refused := g.authenticate(r.Context(), r)
	if refused != nil {
		if refused.Status == http.StatusUnauthorized || refused.Status == http.StatusForbidden {
			g.fails.fail(ip)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(refused.Status)
		doc := obj{"error": refused.Msg}
		if refused.Needs != "" {
			doc["needs"] = refused.Needs
		}
		json.NewEncoder(w).Encode(doc)
		return
	}
	adopted := false
	if !p.secret {
		adopted = g.maybeAdopt(r.Context(), p.key)
	}
	sub := strings.TrimPrefix(r.URL.Path, "/share-admin/")
	w.Header().Set("Content-Type", "application/json")
	switch {
	case sub == "status" && r.Method == http.MethodGet:
		w.Write(g.statusDoc(r.Context(), p, adopted))
	case sub == "links" && r.Method == http.MethodGet:
		json.NewEncoder(w).Encode(obj{"links": g.st.list()})
	case sub == "links" && r.Method == http.MethodPost:
		var in createReq
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&in); err != nil {
			jsonError(w, http.StatusBadRequest, "invalid request")
			return
		}
		o := linkOptions{Label: cleanLabel(in.Label), Players: in.Players, Bases: in.Bases, Realtime: in.Realtime}
		eff := g.effective(r.Context(), p)
		if !eff.Maps || (in.Players && !eff.Players) || (in.Bases && !eff.Bases) || (in.Realtime && !eff.Realtime) {
			jsonError(w, http.StatusBadRequest, "the key (or the gateway's key) cannot offer one of the chosen options")
			return
		}
		if !in.Never {
			o.TTL = time.Duration(in.Seconds) * time.Second
			if o.TTL == 0 {
				jsonError(w, http.StatusBadRequest, "set seconds, or never:true for a link without expiry")
				return
			}
		}
		token, v, err := g.st.create(o)
		switch {
		case errors.Is(err, errTooMany):
			jsonError(w, http.StatusConflict, err.Error())
		case err != nil:
			jsonError(w, http.StatusBadRequest, err.Error())
		default:
			log.Printf("mvshare: link %s created (expires: %s)", v.ID, expiryText(v.Expires))
			w.WriteHeader(http.StatusCreated)
			// the token is shown this once; the gateway keeps only its hash
			json.NewEncoder(w).Encode(obj{"link": v, "token": token, "path": "/s/" + token + "/"})
		}
	case strings.HasPrefix(sub, "links/") && r.Method == http.MethodDelete:
		id := strings.TrimPrefix(sub, "links/")
		if !regexp.MustCompile(`^[0-9a-f]{10}$`).MatchString(id) || !g.st.revoke(id) {
			jsonError(w, http.StatusNotFound, "no such active link")
			return
		}
		log.Printf("mvshare: link %s revoked", id)
		json.NewEncoder(w).Encode(obj{"ok": true})
	default:
		jsonError(w, http.StatusNotFound, "not found")
	}
}

func expiryText(e int64) string {
	if e == 0 {
		return "never"
	}
	return time.Unix(e, 0).UTC().Format(time.RFC3339)
}

func mustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}
