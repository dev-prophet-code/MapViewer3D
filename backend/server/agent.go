package server

// Live-Positionen aus dem Agenten (cmd/mvagent): Sandwürmer, Gegner, Zivilisten und
// Fahrzeuge, gelesen aus dem Speicher der Map-Server (10 Hz). Der Viewer-Server hält
// eine Verbindung zum Agenten (SSE, nur lokal) und reicht sie gefiltert an die Browser
// weiter. Gefiltert wird auf dem Server:
//
//   - Spieler gehen nie hinaus (die kommen aus der Console).
//   - Im öffentlichen Betrieb (-public) nur Partitionen der Erlaubnisliste, die die
//     Seite als PvE meldet: Sandwürmer und Gegner folgen den Spielern, ihre Bewegung
//     würde sonst Spielerpositionen aus PvP-Partitionen verraten.
//
//	GET /api/agent/<karte>         Schnappschuss (JSON), ?partition=N optional
//	GET /api/agent/<karte>/stream  SSE: snap (voller Stand) und pos (Änderungen)

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"mapviewer3d/agent"
)

type agentObj struct {
	agent.ObjOut
	part int
	mapN string
}

// posEvent: Änderungen des Agenten ([id, x, y, z] und verschwundene IDs).
type posEvent struct {
	Gen uint64       `json:"gen"`
	T   int64        `json:"t"`
	D   [][4]float64 `json:"d"`
	R   []uint32     `json:"r"`
}

type agentEvent struct {
	snap *agent.Snapshot
	pos  *posEvent
}

type agentLink struct {
	base string
	stop context.CancelFunc
	// client, header und label: eigener Agent = einfacher http.Client; Realtime
	// Data der Console = Console-Client (consoletls.go) mit API-Key im Header.
	// label erscheint im Log (ohne Zugangsdaten).
	client *http.Client
	header http.Header
	label  string
	// realtime: Verbindung über die Console; denied wird gerufen, wenn sie den
	// Key ablehnt (401/403: deaktiviert, abgelaufen, widerrufen, Recht entzogen).
	realtime bool
	denied   func()

	mu        sync.RWMutex
	snap      agent.Snapshot
	objs      map[uint32]*agentObj
	connected bool
	lastEvent time.Time
	lastErr   string

	subMu sync.Mutex
	subs  map[chan agentEvent]struct{}
}

// UseAgent verbindet den Server mit dem Agenten (z. B. http://127.0.0.1:8796).
func (s *Server) UseAgent(base string) error {
	u, err := url.Parse(strings.TrimRight(base, "/"))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return fmt.Errorf("Agent-Adresse %q: erwartet http://host:port", base)
	}
	s.startAgent(&agentLink{base: u.String(), client: &http.Client{}, label: u.Redacted()})
	return nil
}

func (s *Server) startAgent(l *agentLink) {
	ctx, cancel := context.WithCancel(context.Background())
	l.objs, l.subs, l.stop = map[uint32]*agentObj{}, map[chan agentEvent]struct{}{}, cancel
	s.agentMu.Lock()
	old := s.agent
	s.agent = l
	s.agentMu.Unlock()
	if old != nil {
		old.stop()
	}
	go l.run(ctx)
}

// StopAgent trennt die Verbindung zum Agenten (Tests, Beenden).
func (s *Server) StopAgent() {
	if l := s.agentLink(); l != nil {
		l.stop()
	}
}

func (s *Server) agentLink() *agentLink {
	s.agentMu.RLock()
	defer s.agentMu.RUnlock()
	return s.agent
}

func (l *agentLink) run(ctx context.Context) {
	backoff := time.Second
	for ctx.Err() == nil {
		err := l.connect(ctx)
		var se *agentStatusError
		if l.denied != nil && errors.As(err, &se) && (se.code == http.StatusUnauthorized || se.code == http.StatusForbidden) {
			log.Printf("Echtzeitdaten: die Console lehnt den API-Key ab (HTTP %d: deaktiviert, abgelaufen, widerrufen oder ohne \"Realtime Data\") – Schalter beim nächsten Laden ausgeblendet", se.code)
			l.denied()
			return
		}
		l.mu.Lock()
		l.connected = false
		if err != nil {
			l.lastErr = err.Error()
		}
		l.mu.Unlock()
		if err != nil && backoff >= 30*time.Second {
			log.Printf("Agent %s: %v", l.label, err)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, 30*time.Second)
		if l.recent(5 * time.Second) {
			backoff = time.Second
		}
	}
}

// agentStatusError: der Agent (bzw. die Console) antwortet nicht mit 200.
type agentStatusError struct{ code int }

func (e *agentStatusError) Error() string { return fmt.Sprintf("HTTP %d", e.code) }

func (l *agentLink) recent(d time.Duration) bool {
	l.mu.RLock()
	defer l.mu.RUnlock()
	return time.Since(l.lastEvent) < d
}

// connect liest den Strom, bis er abreißt. Der Agent schickt alle 20 s ein
// Lebenszeichen; bleibt es 65 s aus, gilt die Verbindung als tot.
func (l *agentLink) connect(parent context.Context) error {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, l.base+"/stream", nil)
	for k, v := range l.header {
		req.Header[k] = v
	}
	req.Header.Set("Accept", "text/event-stream")
	resp, err := l.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return &agentStatusError{resp.StatusCode}
	}
	watchdog := time.AfterFunc(65*time.Second, cancel)
	defer watchdog.Stop()
	l.mu.Lock()
	l.connected, l.lastErr = true, ""
	l.mu.Unlock()

	r := bufio.NewReaderSize(resp.Body, 1<<20)
	var name, data string
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return err
		}
		watchdog.Reset(65 * time.Second)
		line = strings.TrimRight(line, "\r\n")
		switch {
		case line == "":
			if name != "" && data != "" {
				l.handle(name, data)
			}
			name, data = "", ""
		case strings.HasPrefix(line, "event:"):
			name = strings.TrimSpace(line[6:])
		case strings.HasPrefix(line, "data:"):
			data = strings.TrimSpace(line[5:])
		}
	}
}

func (l *agentLink) handle(name, data string) {
	switch name {
	case "snap":
		var snap agent.Snapshot
		if json.Unmarshal([]byte(data), &snap) != nil {
			return
		}
		objs := make(map[uint32]*agentObj, len(snap.Objects))
		for _, o := range snap.Objects {
			a := &agentObj{ObjOut: o, part: -1}
			if o.Src >= 0 && o.Src < len(snap.Sources) {
				a.part, a.mapN = snap.Sources[o.Src].Partition, snap.Sources[o.Src].Map
			}
			objs[o.ID] = a
		}
		l.mu.Lock()
		l.snap, l.objs, l.lastEvent = snap, objs, time.Now()
		l.mu.Unlock()
		l.publish(agentEvent{snap: &snap})
	case "pos":
		var p posEvent
		if json.Unmarshal([]byte(data), &p) != nil {
			return
		}
		l.mu.Lock()
		for _, d := range p.D {
			if o := l.objs[uint32(d[0])]; o != nil {
				o.X, o.Y, o.Z = d[1], d[2], d[3]
			}
		}
		for _, id := range p.R {
			delete(l.objs, id)
		}
		l.lastEvent = time.Now()
		l.mu.Unlock()
		l.publish(agentEvent{pos: &p})
	}
}

func (l *agentLink) publish(ev agentEvent) {
	l.subMu.Lock()
	defer l.subMu.Unlock()
	for c := range l.subs {
		select {
		case c <- ev:
		default: // Browser liest nicht mehr: abhängen, er verbindet sich neu
			delete(l.subs, c)
			close(c)
		}
	}
}

func (l *agentLink) subscribe() chan agentEvent {
	c := make(chan agentEvent, 256)
	l.subMu.Lock()
	l.subs[c] = struct{}{}
	l.subMu.Unlock()
	return c
}

func (l *agentLink) unsubscribe(c chan agentEvent) {
	l.subMu.Lock()
	if _, ok := l.subs[c]; ok {
		delete(l.subs, c)
		close(c)
	}
	l.subMu.Unlock()
}

// agentFilter entscheidet, welche Objekte ein Browser für eine Karte sehen darf.
type agentFilter struct {
	mapName  string
	part     int // -1 = alle Partitionen dieser Karte
	allowed  map[int]bool
	restrict bool
	players  []consolePlayer // Spieler laut Console (online), zum Zuordnen der Echtzeitpositionen
}

// ok: Objekte außer Spielern (die gehen nur über matchPlayers hinaus).
func (f agentFilter) ok(o *agentObj) bool {
	if o.Kind == "player" || o.mapN != f.mapName {
		return false
	}
	return f.partOK(o)
}

func (f agentFilter) partOK(o *agentObj) bool {
	if f.part >= 0 && o.part != f.part {
		return false
	}
	if f.restrict && !f.allowed[o.part] {
		return false
	}
	return true
}

func (s *Server) newAgentFilter(r *http.Request, mapName string) agentFilter {
	f := agentFilter{mapName: mapName, part: -1}
	if v := r.URL.Query().Get("partition"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			f.part = n
		}
	}
	if s.public != nil {
		f.restrict, f.allowed = true, s.public.partitions()
	}
	return f
}

// consolePlayer ist ein Spieler, der laut Console online ist.
type consolePlayer struct {
	id   any // wie die Console ihn nennt (Zahl oder Text)
	x, y float64
	part int
}

// maxMatchCm: so weit darf die Position der Console (einige Sekunden alt) von der
// Echtzeitposition abweichen; Ornithopter fliegen ~40 m/s.
const maxMatchCm = 30000

// matchPlayers ordnet Echtzeitspieler (ohne Namen) den Spielern der Console zu:
// gleiche Partition, nächster Abstand zuerst, jeder höchstens einmal. Nicht
// zuordenbare Spieler bleiben unsichtbar – es geht nur hinaus, was die Console
// ohnehin zeigt.
func matchPlayers(live []*agentObj, cons []consolePlayer) map[uint32]any {
	type cand struct {
		a, c int
		d    float64
	}
	var cs []cand
	for i, a := range live {
		for j, c := range cons {
			if a.part != c.part {
				continue
			}
			if d := math.Hypot(a.X-c.x, a.Y-c.y); d <= maxMatchCm {
				cs = append(cs, cand{i, j, d})
			}
		}
	}
	sort.Slice(cs, func(i, j int) bool { return cs[i].d < cs[j].d })
	out := map[uint32]any{}
	usedA, usedC := map[int]bool{}, map[int]bool{}
	for _, c := range cs {
		if usedA[c.a] || usedC[c.c] {
			continue
		}
		usedA[c.a], usedC[c.c] = true, true
		out[live[c.a].ID] = cons[c.c].id
	}
	return out
}

type agentRow struct {
	ID   uint32  `json:"i"`
	Kind string  `json:"k"`
	Cls  string  `json:"c"`
	Part int     `json:"p"`
	X    float64 `json:"x"`
	Y    float64 `json:"y"`
	Z    float64 `json:"z"`
	Yaw  float64 `json:"yaw,omitempty"` // Stürme: Ausrichtung/Fahrtrichtung in Grad (0 = +X)
	PL   any     `json:"pl,omitempty"`  // Spieler: Kennung des Spielers in der Console
}

type agentView struct {
	Enabled   bool       `json:"enabled"`
	Connected bool       `json:"connected"`
	AgeMs     int64      `json:"ageMs"`
	Gen       uint64     `json:"gen"`
	T         int64      `json:"t"`
	Rows      []agentRow `json:"objects"`
	// Weather: Coriolis-Zeitplan (Unix-ms, UTC) der Karte, falls bekannt
	Weather *agent.Weather `json:"weather,omitempty"`
}

func (l *agentLink) view(f agentFilter) agentView {
	l.mu.RLock()
	defer l.mu.RUnlock()
	v := agentView{Enabled: true, Connected: l.connected, Gen: l.snap.Gen, T: time.Now().UnixMilli(), Rows: []agentRow{}}
	if !l.lastEvent.IsZero() {
		v.AgeMs = time.Since(l.lastEvent).Milliseconds()
	}
	// Veraltete Daten (Agent weg, Console-Neustart …) nicht als aktuell ausgeben
	if !l.connected || v.AgeMs > 30000 {
		v.Connected = false
		return v
	}
	var live []*agentObj
	for _, o := range l.objs {
		switch {
		case f.ok(o):
			v.Rows = append(v.Rows, agentRow{ID: o.ID, Kind: o.Kind, Cls: o.Class, Part: o.part, X: math.Round(o.X), Y: math.Round(o.Y), Z: math.Round(o.Z), Yaw: o.Yaw})
		case o.Kind == "player" && o.mapN == f.mapName && f.partOK(o):
			live = append(live, o)
		}
	}
	for _, src := range l.snap.Sources {
		if src.Map == f.mapName && src.Weather != nil && (f.part < 0 || src.Partition == f.part) && (!f.restrict || f.allowed[src.Partition]) {
			v.Weather = src.Weather
			break
		}
	}
	matched := matchPlayers(live, f.players)
	for _, o := range live {
		if pl, ok := matched[o.ID]; ok {
			v.Rows = append(v.Rows, agentRow{ID: o.ID, Kind: "player", Part: o.part, X: math.Round(o.X), Y: math.Round(o.Y), Z: math.Round(o.Z), PL: pl})
		}
	}
	return v
}

func (s *Server) agentMap(w http.ResponseWriter, r *http.Request) (*agentLink, *terrain, bool) {
	l := s.agentLink()
	if l == nil {
		writeJSON(w, agentView{Rows: []agentRow{}})
		return nil, nil, false
	}
	name := r.PathValue("map")
	if !validName.MatchString(name) {
		http.NotFound(w, r)
		return nil, nil, false
	}
	t, err := s.load(name)
	if err != nil {
		http.NotFound(w, r)
		return nil, nil, false
	}
	return l, t, true
}

// consolePlayers liefert die online Spieler der Karte laut Console – genau so gefiltert,
// wie der Browser sie über /api/live/<karte>/players sähe (öffentlich: nur PvE-Partitionen).
func (s *Server) consolePlayers(t *terrain, r *http.Request) []consolePlayer {
	lp := s.lp()
	name := s.liveName(t)
	if lp == nil || name == "" {
		return nil
	}
	path := liveFeeds["players"].path + "?map=" + url.QueryEscape(name)
	c := lp.get(path, liveFeeds["players"].ttl)
	if s.public != nil {
		c = s.public.filterFeed(path, "players", c)
	}
	if c.status != http.StatusOK {
		return nil
	}
	rows, err := decodeRows(c.body)
	if err != nil {
		return nil
	}
	var out []consolePlayer
	for _, row := range rows {
		if row["online_status"] != "Online" {
			continue
		}
		x, ok1 := jsonFloat(row["x"])
		y, ok2 := jsonFloat(row["y"])
		part, has := partitionOf(row)
		if !ok1 || !ok2 || !has {
			continue
		}
		out = append(out, consolePlayer{id: row["id"], x: x, y: y, part: part})
	}
	return out
}

func jsonFloat(v any) (float64, bool) {
	switch x := v.(type) {
	case json.Number:
		f, err := x.Float64()
		return f, err == nil
	case float64:
		return x, true
	}
	return 0, false
}

// agentSnapshot: GET /api/agent/{map}
func (s *Server) agentSnapshot(w http.ResponseWriter, r *http.Request) {
	l, t, ok := s.agentMap(w, r)
	if !ok {
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	f := s.newAgentFilter(r, t.info.Source)
	f.players = s.consolePlayers(t, r)
	writeJSON(w, l.view(f))
}

// agentStream: GET /api/agent/{map}/stream
func (s *Server) agentStream(w http.ResponseWriter, r *http.Request) {
	l, t, ok := s.agentMap(w, r)
	if !ok {
		return
	}
	fl, can := w.(http.Flusher)
	if !can {
		http.Error(w, "kein Streaming", http.StatusInternalServerError)
		return
	}
	f := s.newAgentFilter(r, t.info.Source)
	f.players = s.consolePlayers(t, r)
	rc := http.NewResponseController(w)
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Accel-Buffering", "no") // nginx darf den Strom nicht puffern
	write := func(name string, v any) bool {
		b, err := json.Marshal(v)
		if err != nil {
			return true
		}
		rc.SetWriteDeadline(time.Now().Add(10 * time.Second))
		if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", name, b); err != nil {
			return false
		}
		fl.Flush()
		return true
	}
	c := l.subscribe()
	defer l.unsubscribe(c)
	if !write("snap", l.view(f)) {
		return
	}
	known := map[uint32]bool{} // IDs, die dieser Browser kennt
	for _, row := range l.view(f).Rows {
		known[row.ID] = true
	}
	keep := time.NewTicker(20 * time.Second)
	defer keep.Stop()
	// Die Zuordnung Echtzeitspieler → Console-Spieler gilt nur kurz (Spieler kommen, gehen,
	// stehen nebeneinander): alle 3 s neu bilden und bei Änderung den Stand neu senden.
	rematch := time.NewTicker(3 * time.Second)
	defer rematch.Stop()
	sig := playerSig(l.view(f))
	for {
		select {
		case <-r.Context().Done():
			return
		case <-rematch.C:
			f.players = s.consolePlayers(t, r)
			if v := l.view(f); playerSig(v) != sig {
				sig = playerSig(v)
				known = map[uint32]bool{}
				for _, row := range v.Rows {
					known[row.ID] = true
				}
				if !write("snap", v) {
					return
				}
			}
		case <-keep.C:
			rc.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if _, err := fmt.Fprint(w, ": keepalive\n\n"); err != nil {
				return
			}
			fl.Flush()
		case ev, open := <-c:
			if !open {
				return
			}
			if ev.snap != nil {
				// Voller Stand neu (Entdeckung abgeschlossen): gefiltert neu senden
				v := l.view(f)
				known = map[uint32]bool{}
				for _, row := range v.Rows {
					known[row.ID] = true
				}
				if !write("snap", v) {
					return
				}
				continue
			}
			var d [][4]float64
			for _, x := range ev.pos.D {
				if known[uint32(x[0])] {
					d = append(d, [4]float64{x[0], math.Round(x[1]), math.Round(x[2]), math.Round(x[3])})
				}
			}
			var gone []uint32
			for _, id := range ev.pos.R {
				if known[id] {
					gone = append(gone, id)
					delete(known, id)
				}
			}
			if len(d) == 0 && len(gone) == 0 {
				continue
			}
			if !write("pos", map[string]any{"t": ev.pos.T, "d": d, "r": gone}) {
				return
			}
		}
	}
}

// playerSig fasst die Spielerzuordnung einer Ansicht zusammen (Agenten-ID → Console-ID).
func playerSig(v agentView) string {
	var parts []string
	for _, r := range v.Rows {
		if r.Kind == "player" {
			parts = append(parts, fmt.Sprintf("%d>%v", r.ID, r.PL))
		}
	}
	sort.Strings(parts)
	return strings.Join(parts, ",")
}
