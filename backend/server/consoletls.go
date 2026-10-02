package server

// Verbindungen zur Dune-Docker-Console: normales Zertifikat (Zertifikatsstellen
// des Systems) oder – für selbst signierte bzw. interne Zertifikate wie Caddy
// "tls internal" – ein festgelegter Fingerabdruck: SHA-256 des öffentlichen
// Schlüssels, "sha256/<base64url>". Ist er gesetzt, wird genau dieser Schlüssel
// angenommen und kein anderer. Quelle: -api-pin/apiPin/MV_API_PIN (gilt immer)
// oder der beim Server gespeicherte Fingerabdruck (Serverliste, servers.go).

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"net/http"
	"regexp"
	"sync/atomic"
	"time"
)

var (
	consoleFlagPin   atomic.Pointer[string] // -api-pin
	consoleActivePin atomic.Pointer[string] // Fingerabdruck der aktiven Verbindung
)

var pinPattern = regexp.MustCompile(`^sha256/[A-Za-z0-9_-]{43}$`)

// errConsolePin: die Console zeigt einen anderen Schlüssel als festgelegt.
var errConsolePin = errors.New("Schlüssel der Console passt nicht zum festgelegten Fingerabdruck (-api-pin) – möglicher Angriff")

// SetConsolePin legt den Fingerabdruck für alle Verbindungen fest (-api-pin;
// "" = je Server bzw. Zertifikatsstellen des Systems).
func SetConsolePin(pin string) error {
	if err := checkPin(pin); err != nil {
		return err
	}
	consoleFlagPin.Store(&pin)
	return nil
}

func checkPin(pin string) error {
	if pin != "" && !pinPattern.MatchString(pin) {
		return fmt.Errorf("Fingerabdruck %q: erwartet sha256/<43 Zeichen base64url>", pin)
	}
	return nil
}

func setActivePin(pin string) { consoleActivePin.Store(&pin) }

// currentConsolePin: -api-pin, sonst der Fingerabdruck der aktiven Verbindung.
func currentConsolePin() string {
	if p := consoleFlagPin.Load(); p != nil && *p != "" {
		return *p
	}
	if p := consoleActivePin.Load(); p != nil {
		return *p
	}
	return ""
}

// CertPin ist der Fingerabdruck eines Zertifikats (SHA-256 des öffentlichen Schlüssels).
func CertPin(cert *x509.Certificate) string {
	h := sha256.Sum256(cert.RawSubjectPublicKeyInfo)
	return "sha256/" + base64.RawURLEncoding.EncodeToString(h[:])
}

// consoleTLS liefert die TLS-Einstellungen für host; der Fingerabdruck wird bei
// jedem Verbindungsaufbau neu gelesen.
func consoleTLS(host, pin string) *tls.Config {
	cfg := &tls.Config{MinVersion: tls.VersionTLS12, ServerName: host, NextProtos: []string{"http/1.1"}}
	if pin == "" {
		return cfg
	}
	// Statt der Kette (für interne Zertifikate ohnehin unbekannt) zählt genau ein
	// Schlüssel; Go prüft weiterhin die Signatur im Handshake, also dass die
	// Gegenseite diesen Schlüssel besitzt.
	cfg.InsecureSkipVerify = true
	cfg.VerifyConnection = func(cs tls.ConnectionState) error {
		if len(cs.PeerCertificates) == 0 || subtle.ConstantTimeCompare([]byte(CertPin(cs.PeerCertificates[0])), []byte(pin)) != 1 {
			return errConsolePin
		}
		return nil
	}
	return cfg
}

// newConsoleClient ist ein HTTP-Client für die Console mit dieser Prüfung.
func newConsoleClient(timeout time.Duration) *http.Client {
	return &http.Client{Timeout: timeout, Transport: newConsoleTransport()}
}

func newConsoleTransport() *http.Transport {
	return newConsoleTransportWith(&net.Dialer{Timeout: 10 * time.Second}, currentConsolePin)
}

// newConsoleTransportWith nimmt d für alle Verbindungen (mit und ohne TLS) und
// fragt pin bei jedem Verbindungsaufbau.
func newConsoleTransportWith(d *net.Dialer, pin func() string) *http.Transport {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.ForceAttemptHTTP2 = false
	tr.DialContext = d.DialContext
	tr.DialTLSContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		host, _, err := net.SplitHostPort(addr)
		if err != nil {
			return nil, err
		}
		raw, err := d.DialContext(ctx, network, addr)
		if err != nil {
			return nil, err
		}
		c := tls.Client(raw, consoleTLS(host, pin()))
		if err := c.HandshakeContext(ctx); err != nil {
			raw.Close()
			return nil, err
		}
		return c, nil
	}
	return tr
}

// peerPin liest nur das Zertifikat der Gegenseite (es wird nichts gesendet) und
// liefert seinen Fingerabdruck – für die Meldung, welchen Wert man festlegen kann.
func peerPin(ctx context.Context, addr string) (string, error) {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return "", err
	}
	d := tls.Dialer{Config: &tls.Config{InsecureSkipVerify: true, ServerName: host}}
	c, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		return "", err
	}
	defer c.Close()
	certs := c.(*tls.Conn).ConnectionState().PeerCertificates
	if len(certs) == 0 {
		return "", errors.New("kein Zertifikat")
	}
	return CertPin(certs[0]), nil
}

// isCertError: Zertifikat nicht vertrauenswürdig bzw. falscher Name.
func isCertError(err error) bool {
	var ua x509.UnknownAuthorityError
	var hn x509.HostnameError
	var ci x509.CertificateInvalidError
	var tv *tls.CertificateVerificationError
	return errors.As(err, &ua) || errors.As(err, &hn) || errors.As(err, &ci) || errors.As(err, &tv)
}
