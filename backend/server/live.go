package server

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sync"
	"time"
)

// LiveConfig verbindet den Editor mit der API der Dune-Docker-Console.
// Der Token bleibt auf dem Server; der Browser spricht nur mit /api/live/*.
type LiveConfig struct {
	APIBase string            `json:"apiBase"` // z. B. http://<server>:8088
	Token   string            `json:"token"`   // dak_<id>_<secret>
	Maps    map[string]string `json:"maps"`    // optional: Kartenordner -> Live-Name (sonst aus meta.json)

	// Nur mit -config (feste Konfigurationsdatei statt Einrichtung im Browser):
	Partitions map[string]string `json:"partitions"` // Anzeigenamen, z. B. "1": "PvE"
	Public     *PublicConfig     `json:"public"`     // öffentlicher Betrieb, siehe public.go

	// Zugangsschutz für den Viewer selbst (HTTP-Basic-Login, Benutzername egal).
	ViewerPassword string `json:"viewerPassword"`

	// Adresse des Positions-Agenten (cmd/mvagent), z. B. http://127.0.0.1:8796:
	// zeigt Sandwürmer, Gegner und Fahrzeuge live.
	AgentURL string `json:"agentUrl"`

	// Kopplungscode (mvlive1:…) eines mvgate auf einem Dune-Docker-Host
	// (Branch ddp): Echtzeitdaten über securelink. Wie ein Passwort behandeln.
	AgentPairing string `json:"agentPairing"`

	// Updates automatisch von GitHub installieren (wie -auto-update).
	AutoUpdate bool `json:"autoUpdate"`

	// Kartendaten: leer/"auto" = aus dem Branch cdn streamen, "off" = nur lokal, sonst eigene Adresse.
	CDN string `json:"cdn"`
}

// LoadLiveConfig liest eine feste Konfigurationsdatei (-config). Zugangsdaten
// stehen dann dort statt verschlüsselt in state/; die Einrichtung im Browser ist aus.
func LoadLiveConfig(file string) (*LiveConfig, error) {
	b, err := os.ReadFile(file)
	if err != nil {
		return nil, err
	}
	var c LiveConfig
	if err := json.Unmarshal(b, &c); err != nil {
		return nil, fmt.Errorf("%s: %w", file, err)
	}
	if c.APIBase == "" || c.Token == "" {
		return nil, fmt.Errorf("%s: apiBase und token sind Pflicht", file)
	}
	return &c, nil
}

// UseConfig verbindet den Server fest mit cfg (vor dem ersten Aufruf).
func (s *Server) UseConfig(cfg *LiveConfig) {
	s.fixed = true
	s.setLive(cfg)
	if cfg.Public != nil {
		s.SetPublic(cfg.Public)
	}
}

// Aktualität je Datenart: Spieler oft, Weltobjekte selten.
var liveFeeds = map[string]struct {
	path string
	ttl  time.Duration
}{
	"players":  {"/api/map/players", 3 * time.Second},
	"overlays": {"/api/map/overlays", 20 * time.Second}, // Fahrzeuge, Basen, Lager
	"poi":      {"/api/map/poi", 5 * time.Minute},       // Ressourcen, POIs, Gegner, Gefahren
	"spice":    {"/api/map/spice", 2 * time.Minute},
}

type cached struct {
	at     time.Time
	status int
	body   []byte
}

type liveProxy struct {
	cfg    *LiveConfig
	client *http.Client
	mu     sync.Mutex
	cache  map[string]*cached
	busy   map[string]*sync.Mutex
}

func newLiveProxy(cfg *LiveConfig) *liveProxy {
	return &liveProxy{cfg: cfg, client: &http.Client{Timeout: 60 * time.Second},
		cache: map[string]*cached{}, busy: map[string]*sync.Mutex{}}
}

// get liefert die Antwort der Console, höchstens ttl alt. Gleichzeitige Anfragen
// auf denselben Pfad warten auf einen gemeinsamen Abruf.
func (p *liveProxy) get(path string, ttl time.Duration) *cached {
	p.mu.Lock()
	lock := p.busy[path]
	if lock == nil {
		lock = &sync.Mutex{}
		p.busy[path] = lock
	}
	p.mu.Unlock()
	lock.Lock()
	defer lock.Unlock()
	p.mu.Lock()
	c := p.cache[path]
	p.mu.Unlock()
	// Fehlerantworten länger merken, damit kaputte Einträge die Console nicht ständig belasten
	if c != nil && (time.Since(c.at) < ttl || (c.status >= 400 && time.Since(c.at) < 15*time.Minute)) {
		return c
	}
	req, _ := http.NewRequest(http.MethodGet, p.cfg.APIBase+path, nil)
	req.Header.Set("Authorization", "Bearer "+p.cfg.Token)
	req.Header.Set("Accept", "application/json")
	resp, err := p.client.Do(req)
	if err != nil {
		log.Printf("Live-API %s: %v", path, err)
		if c != nil {
			return c // alte Daten sind besser als keine
		}
		return &cached{status: http.StatusBadGateway, body: jsonError("Console nicht erreichbar: " + err.Error())}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if resp.StatusCode != http.StatusOK {
		log.Printf("Live-API %s: HTTP %d", path, resp.StatusCode)
		if c != nil && resp.StatusCode == http.StatusTooManyRequests {
			return c
		}
	}
	n := &cached{at: time.Now(), status: resp.StatusCode, body: body}
	p.mu.Lock()
	p.cache[path] = n
	p.mu.Unlock()
	return n
}

func jsonError(msg string) []byte {
	b, _ := json.Marshal(map[string]string{"error": msg})
	return b
}

func writeCached(w http.ResponseWriter, c *cached) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	if !c.at.IsZero() {
		w.Header().Set("X-Data-Age", fmt.Sprintf("%.0f", time.Since(c.at).Seconds()))
	}
	w.WriteHeader(c.status)
	w.Write(c.body)
}

func (s *Server) liveStatus(w http.ResponseWriter, r *http.Request) {
	if s.lp() == nil {
		writeJSON(w, map[string]any{"enabled": false, "agent": s.agentLink() != nil})
		return
	}
	writeJSON(w, map[string]any{"enabled": true, "public": s.public != nil, "agent": s.agentLink() != nil})
}

// liveFeed: GET /api/live/{map}/{feed}
func (s *Server) liveFeed(w http.ResponseWriter, r *http.Request) {
	if s.lp() == nil {
		http.Error(w, "Live-Karte nicht konfiguriert (config.json)", http.StatusServiceUnavailable)
		return
	}
	f, known := liveFeeds[r.PathValue("feed")]
	if !known || !validName.MatchString(r.PathValue("map")) {
		http.NotFound(w, r)
		return
	}
	t, err := s.load(r.PathValue("map"))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	liveName := s.liveName(t)
	if liveName == "" {
		http.Error(w, "keine Live-Daten für diese Karte", http.StatusNotFound)
		return
	}
	path := f.path + "?map=" + url.QueryEscape(liveName)
	c := s.lp().get(path, f.ttl)
	if s.public != nil {
		c = s.public.filterFeed(path, r.PathValue("feed"), c)
	} else if !s.adminAllowed(r) {
		c = s.stripPrivate(path, c)
	}
	writeCached(w, c)
}

var baseID = regexp.MustCompile(`^[0-9]{1,12}$`)

// liveBase: GET /api/live/base/{id} – alle Bauteile und Platzierbaren einer Basis.
func (s *Server) liveBase(w http.ResponseWriter, r *http.Request) {
	if s.lp() == nil {
		http.Error(w, "Live-Karte nicht konfiguriert", http.StatusServiceUnavailable)
		return
	}
	id := r.PathValue("id")
	if !baseID.MatchString(id) {
		http.Error(w, "ungültige Basis-ID", http.StatusBadRequest)
		return
	}
	if s.public != nil && !s.publicBaseAllowed(id) {
		http.Error(w, "Basis nicht freigegeben", http.StatusNotFound)
		return
	}
	path := "/api/bases/" + id + "/export"
	c := s.lp().get(path, 2*time.Minute)
	if s.public == nil && !s.adminAllowed(r) {
		c = s.stripPrivate(path, c)
	}
	writeCached(w, c)
}
