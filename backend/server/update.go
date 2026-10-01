package server

import (
	"context"
	"log"
	"net/http"

	"mapviewer3d/updater"
)

// SetUpdater aktiviert die Update-Anzeige und die Installation per Klick (updater.go).
func (s *Server) SetUpdater(u *updater.Updater) { s.upd = u }

// updateStatus: Stand der Update-Prüfung. Öffentlich (-public) gibt es keine Anzeige.
func (s *Server) updateStatus(w http.ResponseWriter, r *http.Request) {
	if s.upd == nil || s.HasPublicFilter() {
		writeJSON(w, map[string]any{"enabled": false})
		return
	}
	writeJSON(w, map[string]any{"enabled": true, "admin": s.adminAllowed(r), "status": s.upd.Status()})
}

func (s *Server) updateAllowed(w http.ResponseWriter, r *http.Request) bool {
	if s.upd == nil || s.HasPublicFilter() {
		http.NotFound(w, r)
		return false
	}
	if !sameOrigin(r) {
		fail(w, http.StatusForbidden, "bad_request", "origin")
		return false
	}
	if !s.adminAllowed(r) {
		fail(w, http.StatusForbidden, "remote_forbidden", "")
		return false
	}
	return true
}

func (s *Server) updateCheck(w http.ResponseWriter, r *http.Request) {
	if !s.updateAllowed(w, r) {
		return
	}
	if err := s.upd.Check(r.Context()); err != nil {
		log.Printf("Update-Prüfung: %v", err)
	}
	writeJSON(w, map[string]any{"status": s.upd.Status()})
}

// updateInstall startet die Installation im Hintergrund; die Oberfläche fragt den Stand ab.
func (s *Server) updateInstall(w http.ResponseWriter, r *http.Request) {
	if !s.updateAllowed(w, r) {
		return
	}
	st := s.upd.Status()
	if !st.Available || !st.CanApply {
		http.Error(w, "kein installierbares Update", http.StatusConflict)
		return
	}
	go func() {
		if err := s.upd.Install(context.Background()); err != nil {
			log.Printf("Update fehlgeschlagen: %v", err)
		}
	}()
	writeJSON(w, map[string]any{"started": true})
}
