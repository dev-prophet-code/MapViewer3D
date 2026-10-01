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
	"fmt"
	"log"
	"math"
	"net/http"
	"net/url"
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
	ctx, cancel := context.WithCancel(context.Background())
	l := &agentLink{base: u.String(), objs: map[uint32]*agentObj{}, subs: map[chan agentEvent]struct{}{}, stop: cancel}
	s.agentMu.Lock()
	s.agent = l
	s.agentMu.Unlock()
	go l.run(ctx)
	return nil
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
		l.mu.Lock()
		l.connected = false
		if err != nil {
			l.lastErr = err.Error()
		}
		l.mu.Unlock()
		if err != nil && backoff >= 30*time.Second {
			log.Printf("Agent %s: %v", l.base, err)
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
	req.Header.Set("Accept", "text/event-stream")
	resp, err := (&http.Client{}).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
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
}

func (f agentFilter) ok(o *agentObj) bool {
	if o.Kind == "player" || o.mapN != f.mapName {
		return false
	}
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

type agentRow struct {
	ID   uint32  `json:"i"`
	Kind string  `json:"k"`
	Cls  string  `json:"c"`
	Part int     `json:"p"`
	X    float64 `json:"x"`
	Y    float64 `json:"y"`
	Z    float64 `json:"z"`
}

type agentView struct {
	Enabled   bool       `json:"enabled"`
	Connected bool       `json:"connected"`
	AgeMs     int64      `json:"ageMs"`
	Gen       uint64     `json:"gen"`
	T         int64      `json:"t"`
	Rows      []agentRow `json:"objects"`
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
	for _, o := range l.objs {
		if f.ok(o) {
			v.Rows = append(v.Rows, agentRow{o.ID, o.Kind, o.Class, o.part, math.Round(o.X), math.Round(o.Y), math.Round(o.Z)})
		}
	}
	return v
}

func (s *Server) agentMap(w http.ResponseWriter, r *http.Request) (*agentLink, string, bool) {
	l := s.agentLink()
	if l == nil {
		writeJSON(w, agentView{Rows: []agentRow{}})
		return nil, "", false
	}
	name := r.PathValue("map")
	if !validName.MatchString(name) {
		http.NotFound(w, r)
		return nil, "", false
	}
	t, err := s.load(name)
	if err != nil {
		http.NotFound(w, r)
		return nil, "", false
	}
	return l, t.info.Source, true
}

// agentSnapshot: GET /api/agent/{map}
func (s *Server) agentSnapshot(w http.ResponseWriter, r *http.Request) {
	l, src, ok := s.agentMap(w, r)
	if !ok {
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, l.view(s.newAgentFilter(r, src)))
}

// agentStream: GET /api/agent/{map}/stream
func (s *Server) agentStream(w http.ResponseWriter, r *http.Request) {
	l, src, ok := s.agentMap(w, r)
	if !ok {
		return
	}
	fl, can := w.(http.Flusher)
	if !can {
		http.Error(w, "kein Streaming", http.StatusInternalServerError)
		return
	}
	f := s.newAgentFilter(r, src)
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
	for {
		select {
		case <-r.Context().Done():
			return
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
