package main

import (
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"

	"mvgate/securelink"
)

// TestEndToEnd: plain HTTP on loopback (viewer) -> mvlink -> securelink -> gate stand-in.
func TestEndToEnd(t *testing.T) {
	id, _ := securelink.LoadOrCreateIdentity(t.TempDir())
	tok := securelink.NewToken()
	inner, _ := net.Listen("tcp", "127.0.0.1:0")
	ln, _ := securelink.Listen(inner, securelink.ServerConfig{Cert: id, Token: tok})
	gate := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "agent:"+r.URL.Path)
	})}
	go gate.Serve(ln)
	defer gate.Close()

	p := securelink.Pairing{Addr: inner.Addr().String(), Pin: securelink.Pin(id.Leaf), Token: tok}
	code := p.Encode()
	q, err := securelink.ParsePairing(code)
	if err != nil {
		t.Fatal(err)
	}
	h, _ := newHandler(q)
	link := httptest.NewServer(h)
	defer link.Close()

	resp, err := http.Get(link.URL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(b) != "agent:/healthz" {
		t.Fatalf("got %q", b)
	}
	// DNS rebinding: a web page that resolves its own name to 127.0.0.1
	req, _ := http.NewRequest(http.MethodGet, link.URL+"/healthz", nil)
	req.Host = "evil.example"
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("foreign Host header: %d", resp.StatusCode)
	}
	req, _ = http.NewRequest(http.MethodGet, link.URL+"/stream", nil)
	req.Header.Set("Origin", "https://evil.example")
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("browser request: %d", resp.StatusCode)
	}
	// wrong token: mvlink reports the gate as unreachable/rejecting
	bad := q
	bad.Token = securelink.NewToken()
	h2, _ := newHandler(bad)
	link2 := httptest.NewServer(h2)
	defer link2.Close()
	resp, err = http.Get(link2.URL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("wrong token: %d", resp.StatusCode)
	}
}
