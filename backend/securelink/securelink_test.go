package securelink

import (
	"bytes"
	"context"
	"crypto/tls"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// gate starts an authenticated HTTP server that answers "hello" and returns
// its pairing.
func gate(t *testing.T, onFail func(net.IP, error)) Pairing {
	t.Helper()
	id, err := LoadOrCreateIdentity(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	tok := NewToken()
	inner, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ln, err := Listen(inner, ServerConfig{Cert: id, Token: tok, OnFail: onFail})
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.TLS == nil || r.TLS.Version != tls.VersionTLS13 {
			t.Errorf("request without TLS 1.3")
		}
		io.WriteString(w, "hello")
	})}
	go srv.Serve(ln)
	t.Cleanup(func() { srv.Close() })
	return Pairing{Addr: inner.Addr().String(), Pin: Pin(id.Leaf), Token: tok}
}

func fetch(p Pairing) (string, error) {
	c := &http.Client{Transport: Transport(p), Timeout: 5 * time.Second}
	resp, err := c.Get("https://mvgate/x")
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	return string(b), err
}

func TestRoundTrip(t *testing.T) {
	p := gate(t, nil)
	if got, err := fetch(p); err != nil || got != "hello" {
		t.Fatalf("got %q, %v", got, err)
	}
}

func TestWrongTokenNeverReachesHTTP(t *testing.T) {
	var mu sync.Mutex
	var fails []error
	p := gate(t, func(_ net.IP, err error) { mu.Lock(); fails = append(fails, err); mu.Unlock() })
	p.Token = NewToken()
	if _, err := fetch(p); err == nil {
		t.Fatal("wrong token accepted")
	}
	time.Sleep(100 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if len(fails) == 0 || !errors.Is(fails[0], ErrAuth) {
		t.Fatalf("server did not report the failed proof: %v", fails)
	}
}

func TestWrongPinIsRejected(t *testing.T) {
	p := gate(t, nil)
	other, _ := LoadOrCreateIdentity(t.TempDir())
	p.Pin = Pin(other.Leaf)
	if _, err := fetch(p); err == nil || !strings.Contains(err.Error(), "pinned") {
		t.Fatalf("expected pin error, got %v", err)
	}
}

func TestPlainHTTPIsRefused(t *testing.T) {
	p := gate(t, nil)
	// plain HTTP to the gate port: the TLS server never answers with HTTP
	conn, err := net.Dial("tcp", p.Addr)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	io.WriteString(conn, "GET / HTTP/1.1\r\nHost: x\r\n\r\n")
	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	b, _ := io.ReadAll(conn)
	if bytes.Contains(b, []byte("hello")) || bytes.HasPrefix(b, []byte("HTTP/")) {
		t.Fatalf("plain HTTP got an answer: %q", b)
	}
	// and the client transport never speaks plain HTTP
	c := &http.Client{Transport: Transport(p)}
	if _, err := c.Get("http://" + p.Addr + "/"); err == nil {
		t.Fatal("transport allowed plain http")
	}
}

// TestRelayMITM: an attacker who even knows the pin (but not the private key)
// cannot terminate TLS; so here we give the attacker the strongest position
// possible – the client accepts the attacker's key (as if the pin were swapped
// in transit) – and check that (1) the token is never visible to the attacker
// and (2) relaying the client's proof to the real gate fails because it is
// bound to the attacker's TLS session, not to the gate's.
func TestRelayMITM(t *testing.T) {
	var mu sync.Mutex
	var fails []error
	real := gate(t, func(_ net.IP, err error) { mu.Lock(); fails = append(fails, err); mu.Unlock() })

	evil, _ := LoadOrCreateIdentity(t.TempDir())
	mitm, _ := net.Listen("tcp", "127.0.0.1:0")
	defer mitm.Close()
	seen := make(chan []byte, 1)
	go func() {
		c, err := mitm.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		tc := tls.Server(c, ServerTLSConfig(evil))
		if tc.Handshake() != nil {
			return
		}
		// read the client's preamble in clear (attacker's view) and forward it
		buf := make([]byte, len(magic)+proofLen)
		io.ReadFull(tc, buf)
		seen <- append([]byte(nil), buf...)
		up, err := tls.Dial("tcp", real.Addr, ClientTLSConfig(real.Pin))
		if err != nil {
			return
		}
		defer up.Close()
		up.Write(buf)
		up.SetReadDeadline(time.Now().Add(2 * time.Second))
		resp := make([]byte, len(magic)+proofLen)
		if _, err := io.ReadFull(up, resp); err == nil {
			tc.Write(resp)
		}
	}()

	victim := real
	victim.Addr = mitm.Addr().String()
	victim.Pin = Pin(evil.Leaf) // worst case: attacker managed to swap the pin
	if _, err := fetch(victim); err == nil {
		t.Fatal("client accepted a relayed session")
	}
	got := <-seen
	if bytes.Contains(got, []byte(real.Token)) {
		t.Fatal("token visible to the attacker")
	}
	time.Sleep(100 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if len(fails) == 0 || !errors.Is(fails[0], ErrAuth) {
		t.Fatalf("real gate accepted the relayed proof: %v", fails)
	}
}

func TestOldTLSRefused(t *testing.T) {
	p := gate(t, nil)
	_, err := tls.Dial("tcp", p.Addr, &tls.Config{InsecureSkipVerify: true, MaxVersion: tls.VersionTLS12})
	if err == nil {
		t.Fatal("TLS 1.2 accepted")
	}
}

func TestPairingCode(t *testing.T) {
	p := Pairing{Addr: "dune.example:8797", Pin: "sha256/abc", Token: NewToken()}
	q, err := ParsePairing(p.Encode())
	if err != nil || q.Addr != p.Addr || q.Pin != p.Pin || q.Token != p.Token {
		t.Fatalf("%+v %v", q, err)
	}
	if strings.Contains(q.String(), p.Token) {
		t.Fatal("String leaks the token")
	}
	for _, bad := range []string{"", "mvlive1:", "mvlive1:!!", "http://x", (Pairing{Addr: "x:1", Pin: "sha256/a", Token: "short"}).Encode()} {
		if _, err := ParsePairing(bad); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
}

func TestIdentityIsStableAndPrivate(t *testing.T) {
	dir := t.TempDir()
	a, err := LoadOrCreateIdentity(dir)
	if err != nil {
		t.Fatal(err)
	}
	b, err := LoadOrCreateIdentity(dir)
	if err != nil || Pin(a.Leaf) != Pin(b.Leaf) {
		t.Fatal("identity changed on reload")
	}
	st, _ := os.Stat(filepath.Join(dir, "gate-key.pem"))
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("key mode %v", st.Mode().Perm())
	}
	tok, err := LoadOrCreateToken(filepath.Join(dir, "token"))
	if err != nil || CheckToken(tok) != nil {
		t.Fatal(err)
	}
	tok2, _ := LoadOrCreateToken(filepath.Join(dir, "token"))
	if tok != tok2 {
		t.Fatal("token changed on reload")
	}
}

func TestDialTimeoutOnSilentServer(t *testing.T) {
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	defer ln.Close()
	go func() {
		c, _ := ln.Accept()
		if c != nil {
			time.Sleep(3 * time.Second)
			c.Close()
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err := Dial(ctx, Pairing{Addr: ln.Addr().String(), Pin: "sha256/x", Token: NewToken()})
	if err == nil || time.Since(start) > 2*time.Second {
		t.Fatalf("dial did not time out: %v", err)
	}
}
