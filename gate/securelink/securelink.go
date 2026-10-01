// Package securelink is the transport between a MapViewer3D on a player's or
// admin's PC and mvgate on a Dune Docker host.
//
// Guarantees (see SECURITY.md):
//
//   - TLS 1.3 only, no plain-text fallback.
//   - The server certificate is pinned by the SHA-256 of its public key (SPKI).
//     No certificate authority is involved, so a CA-issued or self-made
//     certificate of an attacker is rejected.
//   - The shared token never travels over the wire. After the handshake both
//     sides send an HMAC-SHA256 of a TLS exporter value (RFC 8446 §7.5) keyed
//     with the token. The exporter is unique to this one TLS session, so a
//     proof can neither be replayed nor relayed through a man in the middle
//     (who would have two different sessions), and the client also learns that
//     the server knows the token (mutual authentication).
//   - Authentication finishes before the first HTTP byte; an unauthenticated
//     peer never reaches the HTTP server.
package securelink

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	// Version is the protocol version carried in the pairing code and the preamble.
	Version = 1

	magic        = "MVG1"
	exportLabel  = "EXPORTER-mvgate-auth-v1"
	clientDomain = "mvgate v1 client proof"
	serverDomain = "mvgate v1 server proof"
	proofLen     = sha256.Size
	// MinTokenBytes is the minimum token entropy (bytes before encoding).
	MinTokenBytes = 32
	// AuthTimeout bounds handshake + proof exchange.
	AuthTimeout = 10 * time.Second
	// ALPN keeps HTTP on 1.1 (server-sent events, simple proxying).
	ALPN = "http/1.1"
)

var (
	ErrPin       = errors.New("securelink: server key does not match the pinned fingerprint (possible man in the middle)")
	ErrAuth      = errors.New("securelink: authentication failed")
	ErrBadPair   = errors.New("securelink: invalid pairing code")
	ErrWeakToken = fmt.Errorf("securelink: token must be at least %d random bytes", MinTokenBytes)
)

// ---------------------------------------------------------------- keys & pins

// Pin returns the fingerprint of a certificate's public key:
// "sha256/" + base64url(SHA-256(SubjectPublicKeyInfo)), without padding.
func Pin(cert *x509.Certificate) string {
	h := sha256.Sum256(cert.RawSubjectPublicKeyInfo)
	return "sha256/" + base64.RawURLEncoding.EncodeToString(h[:])
}

// LoadOrCreateIdentity loads the gate's key pair from dir or creates a new
// ECDSA P-256 key with a self-signed certificate (valid 20 years). The key file
// is written with mode 0600. Renewing the certificate keeps the key, so the pin
// stays valid.
func LoadOrCreateIdentity(dir string) (tls.Certificate, error) {
	keyPath, certPath := filepath.Join(dir, "gate-key.pem"), filepath.Join(dir, "gate-cert.pem")
	if _, err := os.Stat(keyPath); err == nil {
		c, err := tls.LoadX509KeyPair(certPath, keyPath)
		if err != nil {
			return tls.Certificate{}, fmt.Errorf("securelink: reading the gate identity in %s: %w", dir, err)
		}
		c.Leaf, err = x509.ParseCertificate(c.Certificate[0])
		return c, err
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, err
	}
	der, err := selfSign(key)
	if err != nil {
		return tls.Certificate{}, err
	}
	kb, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return tls.Certificate{}, err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return tls.Certificate{}, err
	}
	if err := writeFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kb}), 0o600); err != nil {
		return tls.Certificate{}, err
	}
	if err := writeFile(certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o644); err != nil {
		return tls.Certificate{}, err
	}
	leaf, err := x509.ParseCertificate(der)
	if err != nil {
		return tls.Certificate{}, err
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key, Leaf: leaf}, nil
}

func selfSign(key *ecdsa.PrivateKey) ([]byte, error) {
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 127))
	if err != nil {
		return nil, err
	}
	now := time.Now()
	tpl := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: "mvgate"},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.AddDate(20, 0, 0),
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
	}
	return x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
}

func writeFile(path string, b []byte, mode os.FileMode) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, mode); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// ---------------------------------------------------------------- tokens

// NewToken returns a fresh random token (32 bytes, hex).
func NewToken() string {
	b := make([]byte, MinTokenBytes)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

// CheckToken rejects tokens that are too short to be safe.
func CheckToken(t string) error {
	if len(t) < 2*MinTokenBytes || strings.ContainsAny(t, " \t\r\n") {
		return ErrWeakToken
	}
	return nil
}

// LoadOrCreateToken returns the token from path, creating one (mode 0600) if missing.
func LoadOrCreateToken(path string) (string, error) {
	if b, err := os.ReadFile(path); err == nil {
		t := strings.TrimSpace(string(b))
		return t, CheckToken(t)
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	t := NewToken()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return "", err
	}
	return t, writeFile(path, []byte(t+"\n"), 0o600)
}

// ---------------------------------------------------------------- pairing

// Pairing is everything a client needs: where, which key, which secret.
type Pairing struct {
	V     int    `json:"v"`
	Addr  string `json:"a"` // host:port of mvgate
	Pin   string `json:"p"`
	Token string `json:"t"`
}

const pairPrefix = "mvlive1:"

// Encode returns the pairing code ("mvlive1:" + base64url JSON). It contains
// the token: handle it like a password.
func (p Pairing) Encode() string {
	p.V = Version
	b, _ := json.Marshal(p)
	return pairPrefix + base64.RawURLEncoding.EncodeToString(b)
}

// ParsePairing decodes and validates a pairing code.
func ParsePairing(code string) (Pairing, error) {
	var p Pairing
	code = strings.TrimSpace(code)
	if !strings.HasPrefix(code, pairPrefix) {
		return p, ErrBadPair
	}
	b, err := base64.RawURLEncoding.DecodeString(code[len(pairPrefix):])
	if err != nil || json.Unmarshal(b, &p) != nil || p.V != Version {
		return p, ErrBadPair
	}
	if _, _, err := net.SplitHostPort(p.Addr); err != nil || !strings.HasPrefix(p.Pin, "sha256/") || CheckToken(p.Token) != nil {
		return p, ErrBadPair
	}
	return p, nil
}

// String hides the token (for logs).
func (p Pairing) String() string { return fmt.Sprintf("mvgate %s (%s)", p.Addr, p.Pin) }

// ---------------------------------------------------------------- proofs

func proof(token, domain string, ekm []byte) []byte {
	m := hmac.New(sha256.New, []byte(token))
	m.Write([]byte(domain))
	m.Write(ekm)
	return m.Sum(nil)
}

func exporter(c *tls.Conn) ([]byte, error) {
	st := c.ConnectionState()
	if st.Version != tls.VersionTLS13 {
		return nil, errors.New("securelink: TLS 1.3 required")
	}
	return st.ExportKeyingMaterial(exportLabel, nil, 32)
}

// ---------------------------------------------------------------- server

// ServerConfig configures Listen.
type ServerConfig struct {
	Cert  tls.Certificate
	Token string
	// Allow, if set, decides by peer IP before any TLS work.
	Allow func(net.IP) bool
	// OnFail is called for every failed authentication (rate limiting, logs).
	OnFail func(ip net.IP, err error)
	// Blocked, if set, refuses an IP before the handshake.
	Blocked func(net.IP) bool
	// MaxPending limits concurrent handshakes (default 64).
	MaxPending int
}

// ServerTLSConfig is the TLS configuration of the gate.
func ServerTLSConfig(cert tls.Certificate) *tls.Config {
	return &tls.Config{
		Certificates: []tls.Certificate{cert},
		MinVersion:   tls.VersionTLS13,
		MaxVersion:   tls.VersionTLS13,
		NextProtos:   []string{ALPN},
	}
}

type listener struct {
	net.Listener
	cfg     ServerConfig
	tlsCfg  *tls.Config
	conns   chan net.Conn
	pending chan struct{}
	done    chan struct{}
	once    sync.Once
	errMu   sync.Mutex
	err     error
}

// Listen wraps a TCP listener. Accept returns only connections that completed
// TLS 1.3 and the mutual token proof; the returned *tls.Conn can be handed to
// http.Server.Serve directly.
func Listen(inner net.Listener, cfg ServerConfig) (net.Listener, error) {
	if err := CheckToken(cfg.Token); err != nil {
		return nil, err
	}
	if cfg.MaxPending <= 0 {
		cfg.MaxPending = 64
	}
	l := &listener{Listener: inner, cfg: cfg, tlsCfg: ServerTLSConfig(cfg.Cert),
		conns: make(chan net.Conn), pending: make(chan struct{}, cfg.MaxPending), done: make(chan struct{})}
	go l.loop()
	return l, nil
}

func (l *listener) loop() {
	for {
		c, err := l.Listener.Accept()
		if err != nil {
			var ne net.Error
			if errors.As(err, &ne) && ne.Timeout() {
				time.Sleep(50 * time.Millisecond)
				continue
			}
			l.errMu.Lock()
			l.err = err
			l.errMu.Unlock()
			l.Close()
			return
		}
		ip := peerIP(c)
		if (l.cfg.Allow != nil && !l.cfg.Allow(ip)) || (l.cfg.Blocked != nil && l.cfg.Blocked(ip)) {
			c.Close()
			continue
		}
		select {
		case l.pending <- struct{}{}:
		default:
			c.Close() // too many handshakes in flight
			continue
		}
		go func() {
			defer func() { <-l.pending }()
			tc, err := l.authenticate(c)
			if err != nil {
				c.Close()
				if l.cfg.OnFail != nil {
					l.cfg.OnFail(ip, err)
				}
				return
			}
			select {
			case l.conns <- tc:
			case <-l.done:
				tc.Close()
			}
		}()
	}
}

func (l *listener) authenticate(raw net.Conn) (*tls.Conn, error) {
	raw.SetDeadline(time.Now().Add(AuthTimeout))
	c := tls.Server(raw, l.tlsCfg)
	if err := c.Handshake(); err != nil {
		return nil, err
	}
	ekm, err := exporter(c)
	if err != nil {
		return nil, err
	}
	buf := make([]byte, len(magic)+proofLen)
	if _, err := io.ReadFull(c, buf); err != nil {
		return nil, err
	}
	if string(buf[:len(magic)]) != magic || !hmac.Equal(buf[len(magic):], proof(l.cfg.Token, clientDomain, ekm)) {
		return nil, ErrAuth
	}
	if _, err := c.Write(append([]byte(magic), proof(l.cfg.Token, serverDomain, ekm)...)); err != nil {
		return nil, err
	}
	raw.SetDeadline(time.Time{})
	return c, nil
}

func (l *listener) Accept() (net.Conn, error) {
	select {
	case c := <-l.conns:
		return c, nil
	case <-l.done:
		l.errMu.Lock()
		defer l.errMu.Unlock()
		if l.err != nil {
			return nil, l.err
		}
		return nil, net.ErrClosed
	}
}

func (l *listener) Close() error {
	var err error
	l.once.Do(func() {
		close(l.done)
		err = l.Listener.Close()
	})
	return err
}

func peerIP(c net.Conn) net.IP {
	if a, ok := c.RemoteAddr().(*net.TCPAddr); ok {
		return a.IP
	}
	host, _, _ := net.SplitHostPort(c.RemoteAddr().String())
	return net.ParseIP(host)
}

// ---------------------------------------------------------------- client

// ClientTLSConfig verifies the server only by its pinned key.
func ClientTLSConfig(pin string) *tls.Config {
	return &tls.Config{
		MinVersion: tls.VersionTLS13,
		MaxVersion: tls.VersionTLS13,
		NextProtos: []string{ALPN},
		// The chain is not checked against a CA on purpose: the pin below is
		// stricter (exactly one key is accepted). Go still verifies the
		// handshake signature, i.e. that the server owns that key.
		InsecureSkipVerify: true,
		VerifyConnection: func(cs tls.ConnectionState) error {
			if len(cs.PeerCertificates) == 0 || !hmac.Equal([]byte(Pin(cs.PeerCertificates[0])), []byte(pin)) {
				return ErrPin
			}
			return nil
		},
	}
}

// Dial opens an authenticated connection to the gate of p.
func Dial(ctx context.Context, p Pairing) (*tls.Conn, error) {
	var d net.Dialer
	raw, err := d.DialContext(ctx, "tcp", p.Addr)
	if err != nil {
		return nil, err
	}
	c, err := ClientHandshake(ctx, raw, p.Pin, p.Token)
	if err != nil {
		raw.Close()
		return nil, err
	}
	return c, nil
}

// Transport is an http.Transport that reaches the gate of p only through
// Dial. Use it with URLs of the form https://mvgate/<path> (the host part is
// ignored; the address comes from the pairing).
func Transport(p Pairing) *http.Transport {
	return &http.Transport{
		DialTLSContext: func(ctx context.Context, _, _ string) (net.Conn, error) { return Dial(ctx, p) },
		DialContext: func(context.Context, string, string) (net.Conn, error) {
			return nil, errors.New("securelink: plain connections are not allowed")
		},
		ForceAttemptHTTP2:   false,
		MaxIdleConns:        4,
		IdleConnTimeout:     90 * time.Second,
		TLSHandshakeTimeout: AuthTimeout,
	}
}

// ClientHandshake runs TLS with pin check and the mutual proof on raw.
func ClientHandshake(ctx context.Context, raw net.Conn, pin, token string) (*tls.Conn, error) {
	deadline := time.Now().Add(AuthTimeout)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	raw.SetDeadline(deadline)
	c := tls.Client(raw, ClientTLSConfig(pin))
	if err := c.HandshakeContext(ctx); err != nil {
		return nil, err
	}
	ekm, err := exporter(c)
	if err != nil {
		return nil, err
	}
	if _, err := c.Write(append([]byte(magic), proof(token, clientDomain, ekm)...)); err != nil {
		return nil, err
	}
	buf := make([]byte, len(magic)+proofLen)
	if _, err := io.ReadFull(c, buf); err != nil {
		return nil, ErrAuth // the gate closes the connection on a wrong token
	}
	if string(buf[:len(magic)]) != magic || !hmac.Equal(buf[len(magic):], proof(token, serverDomain, ekm)) {
		return nil, ErrAuth
	}
	raw.SetDeadline(time.Time{})
	return c, nil
}
