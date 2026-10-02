package server

// ---------- Serverliste ----------
//
//	GET    /api/servers           gespeicherte Server (ohne Token)
//	POST   /api/servers/{id}/use  im laufenden Programm zu diesem Server wechseln
//	DELETE /api/servers/{id}      gespeicherten Server aus der Liste entfernen
//
// Jede eingerichtete Verbindung wird zusätzlich als eigene verschlüsselte Datei
// state/servers/<id>.enc abgelegt (gleicher Hauptschlüssel wie credentials.enc,
// siehe secure.Store.Sibling). credentials.enc bleibt die aktive Verbindung, mit
// der der Viewer startet. Instanznamen gelten je Server.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"mapviewer3d/secure"
)

var serverIDPattern = regexp.MustCompile(`^[0-9a-f]{16}$`)

// serverID: stabile Kennung einer Console-Adresse.
func serverID(apiBase string) string {
	h := sha256.Sum256([]byte(strings.TrimRight(apiBase, "/")))
	return hex.EncodeToString(h[:8])
}

func (s *Server) serversDir() string { return filepath.Join(s.stateDir, "servers") }

func (s *Server) serverStore(id string) (*secure.Store, error) {
	return s.store.Sibling(filepath.Join(s.serversDir(), id+".enc"))
}

// rememberServer legt c in der Serverliste ab (überschreibt denselben Server).
func (s *Server) rememberServer(c secure.Credentials) {
	if s.store == nil {
		return
	}
	st, err := s.serverStore(serverID(c.APIBase))
	if err == nil {
		err = st.Save(c)
	}
	if err != nil {
		log.Printf("Serverliste: %v", err)
	}
}

// activate macht c zur aktiven Verbindung: Console, Zertifikat, Zwischenspeicher
// und Realtime Data (kurz nachgefragt, damit die neu geladene Seite die
// richtigen Schalter zeigt).
func (s *Server) activate(c secure.Credentials) {
	s.setLive(&LiveConfig{APIBase: c.APIBase, Token: c.Token, APIPin: c.Pin})
	s.clearServerCaches()
	s.refreshRealtime()
}

type serverEntry struct {
	ID     string `json:"id"`
	Server string `json:"server"`
	HTTPS  bool   `json:"https"`
	Pinned bool   `json:"pinned"` // Zertifikat per Fingerabdruck festgelegt
	Active bool   `json:"active"`
}

func (s *Server) serverList() []serverEntry {
	out := []serverEntry{}
	if s.store == nil {
		return out
	}
	files, _ := filepath.Glob(filepath.Join(s.serversDir(), "*.enc"))
	active := ""
	if lp := s.lp(); lp != nil {
		active = serverID(lp.cfg.APIBase)
	}
	for _, f := range files {
		id := strings.TrimSuffix(filepath.Base(f), ".enc")
		if !serverIDPattern.MatchString(id) {
			continue
		}
		st, err := s.serverStore(id)
		if err != nil {
			continue
		}
		c, err := st.Load()
		if err != nil {
			continue
		}
		host, secureConn := c.APIBase, false
		if u, err := url.Parse(c.APIBase); err == nil {
			host, secureConn = u.Host, u.Scheme == "https"
		}
		out = append(out, serverEntry{ID: id, Server: host, HTTPS: secureConn, Pinned: c.Pin != "", Active: id == active})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Server < out[j].Server })
	return out
}

func (s *Server) serversGet(w http.ResponseWriter, r *http.Request) {
	if s.fixed || !s.adminAllowed(r) {
		writeJSON(w, []serverEntry{}) // feste Konfiguration bzw. Besucher: nichts umzuschalten
		return
	}
	writeJSON(w, s.serverList())
}

func (s *Server) serverUse(w http.ResponseWriter, r *http.Request) {
	if !s.guard(w, r) {
		return
	}
	if s.fixed {
		fail(w, http.StatusForbidden, "fixed", "")
		return
	}
	id := r.PathValue("id")
	if !serverIDPattern.MatchString(id) {
		http.NotFound(w, r)
		return
	}
	st, err := s.serverStore(id)
	if err != nil {
		fail(w, http.StatusInternalServerError, "save_failed", err.Error())
		return
	}
	c, err := st.Load()
	if err != nil {
		http.NotFound(w, r)
		return
	}
	if err := checkConsole(c.APIBase, c.Token, c.Pin, isLocalRequest(r)); err != nil {
		failErr(w, http.StatusBadGateway, err)
		return
	}
	if err := s.store.Save(*c); err != nil {
		fail(w, http.StatusInternalServerError, "save_failed", err.Error())
		return
	}
	s.activate(*c)
	s.setupStatus(w, r)
}

func (s *Server) serverDelete(w http.ResponseWriter, r *http.Request) {
	if !s.guard(w, r) {
		return
	}
	id := r.PathValue("id")
	if s.fixed || !serverIDPattern.MatchString(id) {
		http.NotFound(w, r)
		return
	}
	if st, err := s.serverStore(id); err == nil {
		if err := st.Delete(); err != nil {
			fail(w, http.StatusInternalServerError, "save_failed", err.Error())
			return
		}
	}
	os.Remove(filepath.Join(s.stateDir, "instance-names-"+id+".json"))
	writeJSON(w, s.serverList())
}

// adoptStoredServer: beim Start die aktive Verbindung in die Serverliste
// übernehmen und alte, serverunabhängige Instanznamen diesem Server zuordnen.
func (s *Server) adoptStoredServer(c secure.Credentials) {
	s.rememberServer(c)
	old := filepath.Join(s.stateDir, "instance-names.json")
	perServer := filepath.Join(s.stateDir, "instance-names-"+serverID(c.APIBase)+".json")
	if _, err := os.Stat(perServer); os.IsNotExist(err) {
		// kopieren statt verschieben: eine ältere Version liest weiter die alte Datei
		if b, err := os.ReadFile(old); err == nil {
			os.WriteFile(perServer, b, 0o600)
		}
	}
}

// refreshRealtime fragt sofort (höchstens 5 s) nach Realtime Data, statt auf die
// nächste Runde der Hintergrundabfrage zu warten.
func (s *Server) refreshRealtime() {
	if !s.realtimeOn.Load() {
		return // eigener Agent (-agent) oder Tests ohne Abfrage
	}
	s.realtimeMu.Lock()
	defer s.realtimeMu.Unlock()
	if l := s.agentLink(); l != nil {
		if !l.realtime {
			return
		}
		s.dropAgentQuiet(l)
	}
	lp := s.lp()
	if lp == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), realtimeProbeTimeout+time.Second)
	defer cancel()
	p := probeRealtime(ctx, lp.cfg)
	s.logRealtime(p)
	if p.ok {
		s.useRealtime(lp.cfg)
	}
}
