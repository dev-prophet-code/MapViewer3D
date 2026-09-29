package server

import (
	"crypto/sha256"
	"crypto/subtle"
	"net/http"
)

// SetPassword schützt den ganzen Viewer mit HTTP-Basic-Login (Benutzer egal,
// Passwort wie hier gesetzt). Leer = kein Login.
func (s *Server) SetPassword(pw string) {
	if pw == "" {
		s.pwHash = nil
		return
	}
	h := sha256.Sum256([]byte(pw))
	s.pwHash = h[:]
}

// HasPassword meldet, ob der Viewer einen Login verlangt.
func (s *Server) HasPassword() bool { return s.pwHash != nil }

// authorized prüft das Passwort in konstanter Zeit (Hashes gleicher Länge).
func (s *Server) authorized(r *http.Request) bool {
	if s.pwHash == nil {
		return true
	}
	_, pw, ok := r.BasicAuth()
	if !ok {
		return false
	}
	h := sha256.Sum256([]byte(pw))
	return subtle.ConstantTimeCompare(h[:], s.pwHash) == 1
}
