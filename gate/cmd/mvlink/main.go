// mvlink runs on the PC next to MapViewer3D. It holds the pairing code,
// connects to mvgate through securelink (TLS 1.3, pinned key, token proof bound
// to the session) and offers the agent routes on loopback only, so an
// unchanged MapViewer3D (Beta.9 or newer) can use it:
//
//	mvlink -pair-file pairing.txt          # or MV_PAIR=mvlive1:…
//	./start.sh -agent http://127.0.0.1:8798
//
// The token never appears in the viewer's configuration, URL or log.
package main

import (
	"context"
	"errors"
	"flag"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"mvgate/securelink"
)

var routes = map[string]bool{"/healthz": true, "/stream": true, "/api/objects": true}

func main() {
	listen := flag.String("listen", "127.0.0.1:8798", "local address for MapViewer3D (loopback only)")
	pairFile := flag.String("pair-file", "", "file with the pairing code (mvlive1:…); alternatively MV_PAIR or stdin with -pair-file -")
	flag.Parse()
	log.SetFlags(log.LstdFlags)

	code, err := readCode(*pairFile)
	if err != nil {
		log.Fatal(err)
	}
	p, err := securelink.ParsePairing(code)
	if err != nil {
		log.Fatal(err)
	}
	host, _, err := net.SplitHostPort(*listen)
	if err != nil {
		log.Fatalf("-listen: %v", err)
	}
	if ip := net.ParseIP(host); host != "localhost" && (ip == nil || !ip.IsLoopback()) {
		log.Fatalf("-listen %s: mvlink only listens on loopback (127.0.0.1); the decrypted data must not leave this PC", *listen)
	}

	h, err := newHandler(p)
	if err != nil {
		log.Fatal(err)
	}
	ln, err := net.Listen("tcp", *listen)
	if err != nil {
		log.Fatal(err)
	}
	srv := &http.Server{Handler: h, ReadHeaderTimeout: 10 * time.Second}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		srv.Close()
	}()
	log.Printf("mvlink: %s, securelink v%d", p, securelink.Version)
	go check(p)
	log.Printf("mvlink: start MapViewer3D with  -agent http://%s", ln.Addr())
	if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

func readCode(file string) (string, error) {
	switch {
	case file == "-":
		b, err := io.ReadAll(io.LimitReader(os.Stdin, 4096))
		return strings.TrimSpace(string(b)), err
	case file != "":
		b, err := os.ReadFile(file)
		return strings.TrimSpace(string(b)), err
	case os.Getenv("MV_PAIR") != "":
		return os.Getenv("MV_PAIR"), nil
	}
	return "", errors.New("no pairing code: use -pair-file <file>, -pair-file - (stdin) or MV_PAIR (create it on the server with: mvgate -pair <host>)")
}

// newHandler proxies the agent routes to the gate. Only requests from this
// machine reach it (loopback listener); Host is checked against DNS rebinding.
func newHandler(p securelink.Pairing) (http.Handler, error) {
	target, _ := url.Parse("https://mvgate")
	proxy := &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(target)
			r.Out.Header = http.Header{"Accept": r.In.Header["Accept"]}
		},
		Transport:     securelink.Transport(p),
		FlushInterval: -1,
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			log.Printf("mvlink: gate: %v", err)
			http.Error(w, "gate unreachable or rejected the connection", http.StatusBadGateway)
		},
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host, _, err := net.SplitHostPort(r.Host)
		if err != nil {
			host = r.Host
		}
		if ip := net.ParseIP(host); host != "localhost" && (ip == nil || !ip.IsLoopback()) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		// MapViewer3D's server calls mvlink, never a browser: a request with an
		// Origin comes from some web page and is refused.
		if r.Header.Get("Origin") != "" || r.Header.Get("Sec-Fetch-Site") == "cross-site" {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if !routes[r.URL.Path] {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		proxy.ServeHTTP(w, r)
	}), nil
}

func check(p securelink.Pairing) {
	c := &http.Client{Transport: securelink.Transport(p), Timeout: 15 * time.Second}
	resp, err := c.Get("https://mvgate/healthz")
	if err != nil {
		log.Printf("mvlink: first connection to the gate failed: %v", err)
		return
	}
	defer resp.Body.Close()
	log.Printf("mvlink: gate verified (key pinned, mutual token proof), agent says %s", resp.Status)
}
