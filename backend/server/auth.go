package server

import (
	"crypto/sha256"
	"crypto/subtle"
	"net"
	"net/http"
	"sync"
	"time"
)

type authAttempt struct {
	fails int
	until time.Time
}

var (
	authMu    sync.Mutex
	authFails = map[string]authAttempt{}
)

// SetPassword schützt den ganzen Viewer mit HTTP-Basic-Login (Benutzer egal,
// Passwort wie hier gesetzt). Leer = kein Login.
func (s *Server) SetPassword(pw string) {
	authMu.Lock()
	authFails = map[string]authAttempt{}
	authMu.Unlock()
	if pw == "" {
		s.pwHash = nil
		return
	}
	h := sha256.Sum256([]byte(pw))
	s.pwHash = h[:]
}

// HasPassword meldet, ob der Viewer einen Login verlangt.
func (s *Server) HasPassword() bool { return s.pwHash != nil }

// authorized prüft das Passwort in konstanter Zeit (Hashes gleicher Länge)
// und bremst Brute-Force-Versuche je Quell-IP nach 10 Fehlversuchen aus.
func (s *Server) authorized(r *http.Request) bool {
	if s.pwHash == nil {
		return true
	}
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		ip = r.RemoteAddr
	}
	now := time.Now()
	authMu.Lock()
	att := authFails[ip]
	if now.Before(att.until) {
		authMu.Unlock()
		return false
	}
	authMu.Unlock()

	_, pw, ok := r.BasicAuth()
	if !ok {
		return false
	}
	h := sha256.Sum256([]byte(pw))
	if subtle.ConstantTimeCompare(h[:], s.pwHash) == 1 {
		authMu.Lock()
		delete(authFails, ip)
		authMu.Unlock()
		return true
	}
	authMu.Lock()
	if len(authFails) > 2048 {
		for k, v := range authFails {
			if now.After(v.until) {
				delete(authFails, k)
			}
		}
	}
	att = authFails[ip]
	att.fails++
	if att.fails >= 10 {
		att.until = now.Add(time.Minute)
		att.fails = 0
	}
	authFails[ip] = att
	authMu.Unlock()
	return false
}
