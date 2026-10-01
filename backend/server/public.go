package server

// Öffentlicher Betrieb: Der Viewer ist in lafamilia-gaming.eu eingebettet und
// darf dort nur die friedlichen Partitionen (PvE) zeigen. Gefiltert wird hier auf
// dem Server – was PvP ist, erreicht den Browser gar nicht erst.
//
// Eingeschaltet wird der Betrieb mit -public <datei> (siehe PublicConfig) oder
// über den Abschnitt "public" der Datei zu -config.
//
// Eine Partition gilt nur, wenn sie BEIDE Tore passiert:
//  1. Sie steht auf der Erlaubnisliste (partitions).
//  2. Die Seite (public.modeSource, lafa2 /api/map/dune) meldet sie als PvE.
//
// Ist die Seite nicht erreichbar, gilt nach kurzer Schonfrist keine Partition –
// dann zeigt der Viewer nur Gelände und Weltobjekte, nie versehentlich PvP.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"mapviewer3d/mapdata"
)

// PublicConfig schaltet den öffentlichen Betrieb ein, z. B.
//
//	{"partitions": [1, 35], "modeSource": "http://127.0.0.1:4200/api/map/dune"}
type PublicConfig struct {
	Partitions []int  `json:"partitions"` // Erlaubnisliste, z. B. [1, 35]
	ModeSource string `json:"modeSource"` // meldet die PvE-Partitionen, z. B. http://127.0.0.1:4200/api/map/dune
}

// LoadPublicConfig liest die Datei zu -public.
func LoadPublicConfig(file string) (*PublicConfig, error) {
	b, err := os.ReadFile(file)
	if err != nil {
		return nil, err
	}
	var c PublicConfig
	if err := json.Unmarshal(b, &c); err != nil {
		return nil, fmt.Errorf("%s: %w", file, err)
	}
	if len(c.Partitions) == 0 || c.ModeSource == "" {
		return nil, fmt.Errorf("%s: partitions und modeSource sind Pflicht", file)
	}
	return &c, nil
}

// HasPublicFilter meldet, ob der öffentliche Betrieb (Partitionsfilter) aktiv ist.
func (s *Server) HasPublicFilter() bool { return s.public != nil }

// SetPublic schaltet den öffentlichen Betrieb ein (vor dem ersten Aufruf).
func (s *Server) SetPublic(cfg *PublicConfig) { s.public = newPublicGate(cfg) }

// Felder, die im öffentlichen Betrieb nie an den Browser gehen.
var privateFields = []string{"account_id", "action_player_id", "funcom_id", "fls_id"}

type publicGate struct {
	cfg    *PublicConfig
	client *http.Client

	mu      sync.Mutex
	checked time.Time    // letzter Abruf von modeSource
	good    time.Time    // letzter erfolgreicher Abruf
	allowed map[int]bool // Ergebnis beider Tore

	fmu      sync.Mutex
	filtered map[string]filteredBody // Pfad → gefilterte Antwort
}

type filteredBody struct {
	src  time.Time // Zeitstempel der Console-Antwort
	key  string    // erlaubte Partitionen beim Filtern
	body []byte
}

func newPublicGate(cfg *PublicConfig) *publicGate {
	return &publicGate{cfg: cfg, client: &http.Client{Timeout: 10 * time.Second},
		allowed: map[int]bool{}, filtered: map[string]filteredBody{}}
}

// partitions liefert die Partitionen, die gezeigt werden dürfen.
func (g *publicGate) partitions() map[int]bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if time.Since(g.checked) < 60*time.Second {
		return g.allowed
	}
	g.checked = time.Now()
	pve, err := g.fetchPvE()
	if err != nil {
		log.Printf("Öffentlich: PvE-Liste nicht abrufbar: %v", err)
		if time.Since(g.good) > 10*time.Minute {
			g.allowed = map[int]bool{}
		}
		return g.allowed
	}
	next := map[int]bool{}
	for _, p := range g.cfg.Partitions {
		if pve[p] {
			next[p] = true
		}
	}
	g.allowed, g.good = next, time.Now()
	return next
}

func (g *publicGate) fetchPvE() (map[int]bool, error) {
	if g.cfg.ModeSource == "" {
		return nil, fmt.Errorf("public.modeSource fehlt")
	}
	resp, err := g.client.Get(g.cfg.ModeSource)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	var doc struct {
		OK         bool `json:"ok"`
		Partitions []struct {
			ID int `json:"id"`
		} `json:"partitions"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&doc); err != nil {
		return nil, err
	}
	if !doc.OK {
		return nil, fmt.Errorf("Quelle meldet ok=false")
	}
	out := map[int]bool{}
	for _, p := range doc.Partitions {
		out[p.ID] = true
	}
	return out, nil
}

func allowedKey(a map[int]bool) string {
	ids := make([]int, 0, len(a))
	for id := range a {
		ids = append(ids, id)
	}
	sort.Ints(ids)
	return fmt.Sprint(ids)
}

// partitionOf liest partition_id einer Zeile; ok=false, wenn sie fehlt oder null ist.
func partitionOf(row map[string]any) (int, bool) {
	v, has := row["partition_id"]
	if !has || v == nil {
		return 0, false
	}
	var n json.Number
	switch x := v.(type) {
	case json.Number:
		n = x
	case string:
		n = json.Number(x)
	default:
		return -1, true // unbekannte Form: als fremde Partition behandeln
	}
	i, err := n.Int64()
	if err != nil {
		return -1, true
	}
	return int(i), true
}

// filterRows behält nur, was öffentlich gezeigt werden darf.
// Spieler, Basen, Fahrzeuge und Lager (players, overlays) brauchen eine erlaubte
// Partition; Weltobjekte ohne Partition (Orte, mögliche Spice-Fundorte) gelten
// überall. Spieler erscheinen nur, solange sie online sind.
func filterRows(feed string, rows []map[string]any, allowed map[int]bool) []map[string]any {
	needsPartition := feed == "players" || feed == "overlays"
	out := make([]map[string]any, 0, len(rows))
	for _, r := range rows {
		pid, has := partitionOf(r)
		if has && !allowed[pid] {
			continue
		}
		if !has && needsPartition {
			continue
		}
		if r["type"] == "player" && r["online_status"] != "Online" {
			continue
		}
		for _, k := range privateFields {
			delete(r, k)
		}
		out = append(out, r)
	}
	return out
}

func decodeRows(body []byte) ([]map[string]any, error) {
	var doc struct {
		Rows []map[string]any `json:"rows"`
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	if err := dec.Decode(&doc); err != nil {
		return nil, err
	}
	return doc.Rows, nil
}

// filterFeed gibt die gefilterte Antwort zurück (nur {"rows": …}), zwischengespeichert,
// solange Console-Antwort und erlaubte Partitionen gleich bleiben.
func (g *publicGate) filterFeed(path, feed string, c *cached) *cached {
	if c.status != http.StatusOK {
		return &cached{at: c.at, status: c.status, body: jsonError("Live-Daten nicht verfügbar")}
	}
	allowed := g.partitions()
	key := allowedKey(allowed)
	g.fmu.Lock()
	f, ok := g.filtered[path]
	g.fmu.Unlock()
	if ok && f.src.Equal(c.at) && f.key == key {
		return &cached{at: c.at, status: http.StatusOK, body: f.body}
	}
	rows, err := decodeRows(c.body)
	if err != nil {
		return &cached{at: c.at, status: http.StatusBadGateway, body: jsonError("Live-Daten unlesbar")}
	}
	body, _ := json.Marshal(map[string]any{"rows": filterRows(feed, rows, allowed)})
	g.fmu.Lock()
	g.filtered[path] = filteredBody{src: c.at, key: key, body: body}
	g.fmu.Unlock()
	return &cached{at: c.at, status: http.StatusOK, body: body}
}

// publicBaseAllowed: Die Basis muss in den gefilterten Overlays einer Karte stehen.
func (s *Server) publicBaseAllowed(id string) bool {
	lp := s.lp()
	if lp == nil {
		return false
	}
	for _, name := range s.liveNames() {
		path := liveFeeds["overlays"].path + "?map=" + name
		c := s.public.filterFeed(path, "overlays", lp.get(path, liveFeeds["overlays"].ttl))
		if c.status != http.StatusOK {
			continue
		}
		rows, err := decodeRows(c.body)
		if err != nil {
			continue
		}
		for _, r := range rows {
			if r["type"] == "base" && strings.TrimSpace(fmt.Sprint(r["id"])) == id {
				return true
			}
		}
	}
	return false
}

// mapNames: Karten des Katalogs (Branch cdn) und Kartenordner im Datenverzeichnis, ohne Doppelte.
func (s *Server) mapNames() []string {
	seen := map[string]bool{}
	var out []string
	for _, n := range s.remoteNames() {
		if !seen[n] {
			seen[n] = true
			out = append(out, n)
		}
	}
	entries, _ := os.ReadDir(s.dataDir)
	for _, e := range entries {
		if e.IsDir() && validName.MatchString(e.Name()) && e.Name() != mapdata.DirBuildables && !seen[e.Name()] {
			seen[e.Name()] = true
			out = append(out, e.Name())
		}
	}
	return out
}

// liveNames: Live-Namen aller Karten im Datenordner.
func (s *Server) liveNames() []string {
	seen := map[string]bool{}
	var out []string
	for _, name := range s.mapNames() {
		t, err := s.load(name)
		if err != nil {
			continue
		}
		if n := s.liveName(t); n != "" && !seen[n] {
			seen[n] = true
			out = append(out, n)
		}
	}
	return out
}
