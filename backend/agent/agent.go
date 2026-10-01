// Package agent liest NPC-, Feind-, Sandwurm- und Fahrzeugpositionen aus dem
// Arbeitsspeicher der Dune-Awakening-Map-Server (nur lesend, /proc/<pid>/mem).
//
// Ablauf (siehe docs/Agent-DE.md): Vtable-Adressen der Klassen aus der
// Binary lesen, den Speicher nach Zeigern darauf durchsuchen (Discovery), jeden
// Treffer über den FNamePool benennen und auf Plausibilität prüfen, danach
// nur noch die Weltposition im RootComponent lesen (Tracking, 10 Hz).
package agent

import (
	"context"
	"errors"
	"fmt"
	"log"
	"math"
	"os"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

// Config steuert den Agenten.
type Config struct {
	ProcRoot  string        // Standard /proc
	Hz        float64       // Abtastrate der aktiven Objekte
	Workers   int           // parallele Scan-Worker
	Rescan    time.Duration // volle Discovery in diesem Abstand
	RescanMin time.Duration // frühestens so oft auf Anforderung neu scannen
	Supervise time.Duration // Prozesserkennung (Neustarts, neue Partitionen)
	Players   bool          // auch Spieler ausgeben (aus: Datenschutz)
	StormScan time.Duration // kurze Suche nach Sandstürmen, 0 = Standard (3 min), <0 = aus
	OnlyPID   int           // nur diesen Prozess (Diagnose), 0 = alle
	Offsets   Offsets       // Standard: Build 2134304
}

func (c *Config) defaults() {
	if c.ProcRoot == "" {
		c.ProcRoot = "/proc"
	}
	if c.Hz <= 0 {
		c.Hz = 10
	}
	if c.Workers <= 0 {
		c.Workers = 4
	}
	if c.Rescan <= 0 {
		c.Rescan = 30 * time.Minute
	}
	if c.RescanMin <= 0 {
		c.RescanMin = time.Minute
	}
	if c.StormScan == 0 {
		c.StormScan = 3 * time.Minute
	}
	if c.Supervise <= 0 {
		c.Supervise = 15 * time.Second
	}
	if c.Offsets == (Offsets{}) {
		c.Offsets = DefaultOffsets
	}
}

type Agent struct {
	cfg    Config
	nextID atomic.Uint32
	hub    *Hub
	gen    atomic.Uint64
	sem    chan struct{} // nur eine Discovery gleichzeitig (Speicherbandbreite)

	mu      sync.RWMutex
	sources map[string]*source

	offMu sync.Mutex
	offs  Offsets

	vtMu    sync.Mutex
	vtCache map[string]map[string]uint64
}

func New(cfg Config) *Agent {
	cfg.defaults()
	return &Agent{cfg: cfg, hub: newHub(), sem: make(chan struct{}, 1), sources: map[string]*source{},
		offs: cfg.Offsets, vtCache: map[string]map[string]uint64{}}
}

func (a *Agent) offsets() Offsets {
	a.offMu.Lock()
	defer a.offMu.Unlock()
	return a.offs
}

func (a *Agent) setOffsets(o Offsets) {
	a.offMu.Lock()
	a.offs = o
	a.offMu.Unlock()
}

// vtables liefert die Vtable-Symbole der Binary (je Datei einmal gelesen).
func (a *Agent) vtables(exe string) (map[string]uint64, error) {
	key := exe
	if p, err := os.Readlink(exe); err == nil {
		key = p
	}
	if st, err := os.Stat(exe); err == nil {
		key = fmt.Sprintf("%s|%d|%d", key, st.Size(), st.ModTime().UnixNano())
	}
	a.vtMu.Lock()
	defer a.vtMu.Unlock()
	if v, ok := a.vtCache[key]; ok {
		return v, nil
	}
	v, err := vtableAddrs(exe)
	if err != nil {
		return nil, err
	}
	a.vtCache[key] = v
	return v, nil
}

// Run läuft bis ctx endet.
func (a *Agent) Run(ctx context.Context) {
	go a.supervise(ctx)
	a.trackLoop(ctx)
}

func (a *Agent) supervise(ctx context.Context) {
	for {
		a.syncTargets(ctx)
		select {
		case <-ctx.Done():
			return
		case <-time.After(a.cfg.Supervise):
		}
	}
}

func (a *Agent) syncTargets(ctx context.Context) {
	cur := map[string]Target{}
	for _, t := range findTargets(a.cfg.ProcRoot) {
		if a.cfg.OnlyPID == 0 || t.PID == a.cfg.OnlyPID {
			cur[t.key()] = t
		}
	}
	a.mu.Lock()
	changed := false
	for k, s := range a.sources {
		if _, ok := cur[k]; !ok {
			log.Printf("[%s] Prozess beendet", s.label())
			close(s.cancel)
			delete(a.sources, k)
			changed = true
		}
	}
	for k, t := range cur {
		if _, ok := a.sources[k]; ok {
			continue
		}
		s := newSource(a, t)
		a.sources[k] = s
		changed = true
		log.Printf("[%s] neuer Map-Prozess", s.label())
		go a.runSource(ctx, s)
		go a.stormLoop(ctx, s)
	}
	a.mu.Unlock()
	if changed {
		a.publishSnapshot()
	}
}

// runSource: erste Discovery, dann regelmäßig oder auf Anforderung neu.
func (a *Agent) runSource(ctx context.Context, s *source) {
	defer s.close()
	for {
		select {
		case a.sem <- struct{}{}:
		case <-ctx.Done():
			return
		case <-s.cancel:
			return
		}
		err := s.scan()
		<-a.sem
		wait := a.cfg.Rescan
		if err != nil {
			s.setReason(err.Error())
			log.Printf("[%s] Anbindung fehlgeschlagen: %v", s.label(), err)
			if !errors.Is(err, errNoActors) {
				wait = 30 * time.Second
			}
		}
		a.publishSnapshot()
		select {
		case <-ctx.Done():
			return
		case <-s.cancel:
			return
		case <-time.After(wait):
		case <-s.rescan:
			// gebündelt: nicht öfter als RescanMin
			if d := a.cfg.RescanMin - time.Since(s.scanAt); d > 0 {
				select {
				case <-time.After(d):
				case <-ctx.Done():
					return
				case <-s.cancel:
					return
				}
			}
		}
	}
}

// stormLoop sucht regelmäßig nur nach Sturm-Objekten (billiger als die volle Discovery).
func (a *Agent) stormLoop(ctx context.Context, s *source) {
	if a.cfg.StormScan < 0 {
		return
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-s.cancel:
			return
		case <-time.After(a.cfg.StormScan):
		}
		select {
		case a.sem <- struct{}{}:
		case <-ctx.Done():
			return
		case <-s.cancel:
			return
		}
		changed, err := s.scanStorms()
		<-a.sem
		if err != nil {
			continue
		}
		if changed {
			a.publishSnapshot()
		}
	}
}

type tracked struct {
	id         uint32
	addr, root uint64
	vtab       uint64
	kind       string
	x, y, z    float64
	moved      time.Time
}

const (
	activeFor = 10 * time.Second // so lange gilt ein Objekt nach einer Bewegung als aktiv
	slowEvery = 2 * time.Second  // alle Objekte lesen und auf Gültigkeit prüfen
)

func isNPC(kind string) bool { return kind == "npc" || kind == "civilian" }

// trackLoop liest mit Hz die Positionen der aktiven Objekte (Würmer, Fahrzeuge, Spieler
// und alles, was sich zuletzt bewegt hat); alle slowEvery Sekunden alle Objekte samt
// Gültigkeitsprüfung. Steht alles still, kostet ein Takt fast nichts.
func (a *Agent) trackLoop(ctx context.Context) {
	tk := time.NewTicker(time.Duration(float64(time.Second) / a.cfg.Hz))
	defer tk.Stop()
	var lastSlow time.Time
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-tk.C:
			slow := now.Sub(lastSlow) >= slowEvery
			if slow {
				lastSlow = now
			}
			a.tick(now, slow)
		}
	}
}

func (a *Agent) tick(now time.Time, slow bool) {
	a.mu.RLock()
	srcs := make([]*source, 0, len(a.sources))
	for _, s := range a.sources {
		srcs = append(srcs, s)
	}
	a.mu.RUnlock()
	offs := a.offsets()
	var delta [][4]float64
	var gone []uint32
	for _, s := range srcs {
		s.mu.Lock()
		if !s.ready {
			s.mu.Unlock()
			continue
		}
		var list []tracked
		if slow {
			list = make([]tracked, 0, len(s.objs))
			for _, o := range s.objs {
				list = append(list, tracked{o.ID, o.Addr, o.Root, o.Vtab, o.Kind, o.X, o.Y, o.Z, o.moved})
			}
		} else {
			list = make([]tracked, 0, len(s.fast))
			for _, id := range s.fast {
				if o := s.objs[id]; o != nil {
					list = append(list, tracked{o.ID, o.Addr, o.Root, o.Vtab, o.Kind, o.X, o.Y, o.Z, o.moved})
				}
			}
		}
		gone = append(gone, s.removed...)
		s.removed = nil
		s.mu.Unlock()

		var dead []uint32
		type upd struct {
			id      uint32
			x, y, z float64
		}
		var ups []upd
		wormGone := false
		for _, o := range list {
			if slow {
				ai, ok := readActor(s.mem, o.addr, offs.Root)
				if !ok || ai.vtab != o.vtab || ai.flags&(rfBeginDestroyed|rfFinishDestroy) != 0 || ai.root != o.root {
					dead = append(dead, o.id)
					wormGone = wormGone || o.kind == "worm"
					continue
				}
			}
			x, y, z, ok := readVec(s.mem, o.root, offs.Pos)
			if !ok {
				dead = append(dead, o.id)
				wormGone = wormGone || o.kind == "worm"
				continue
			}
			if math.Abs(x-o.x)+math.Abs(y-o.y)+math.Abs(z-o.z) >= 2 {
				ups = append(ups, upd{o.id, x, y, z})
				delta = append(delta, [4]float64{float64(o.id), math.Round(x), math.Round(y), math.Round(z)})
			}
		}
		if len(ups) > 0 || len(dead) > 0 || slow {
			s.mu.Lock()
			for _, u := range ups {
				if o := s.objs[u.id]; o != nil {
					o.X, o.Y, o.Z, o.moved = u.x, u.y, u.z, now
				}
			}
			for _, id := range dead {
				delete(s.objs, id)
				gone = append(gone, id)
			}
			if slow || len(dead) > 0 || len(ups) > 0 {
				s.rebuildFast(now)
			}
			s.mu.Unlock()
		}
		// Ein verschwundener Wurm heißt: ein neuer ist entstanden. Viele verschwundene Objekte
		// (Gegner, Fahrzeuge) lösen ebenfalls eine neue Suche aus; einzelne warten auf die nächste.
		if wormGone || len(dead) >= 25 {
			s.requestRescan()
		}
	}
	if len(delta) > 0 || len(gone) > 0 {
		a.hub.publishPos(a.gen.Load(), now, delta, gone)
	}
}

// ── Ausgabe ────────────────────────────────────────────────────────────────

type SrcInfo struct {
	PID       int    `json:"pid"`
	Map       string `json:"map"`
	Partition int    `json:"partition"`
	Ready     bool   `json:"ready"`
	Count     int    `json:"n"`
	Scans     int    `json:"scans"`
	ScanMs    int64  `json:"scanMs"`
	AgeMs     int64  `json:"ageMs"`
	Reason    string `json:"reason,omitempty"`

	Weather *Weather `json:"weather,omitempty"`
}

type ObjOut struct {
	ID    uint32  `json:"i"`
	Kind  string  `json:"k"`
	Class string  `json:"c"`
	Src   int     `json:"s"` // Index in sources
	X     float64 `json:"x"`
	Y     float64 `json:"y"`
	Z     float64 `json:"z"`
	Yaw   float64 `json:"yaw,omitempty"` // nur Stürme, Grad
}

type Snapshot struct {
	Gen     uint64    `json:"gen"`
	T       int64     `json:"t"`
	Sources []SrcInfo `json:"sources"`
	Objects []ObjOut  `json:"objects"`
}

func (a *Agent) snapshot() Snapshot {
	a.mu.RLock()
	srcs := make([]*source, 0, len(a.sources))
	for _, s := range a.sources {
		srcs = append(srcs, s)
	}
	a.mu.RUnlock()
	sort.Slice(srcs, func(i, j int) bool { return srcs[i].t.PID < srcs[j].t.PID })
	snap := Snapshot{Gen: a.gen.Load(), T: time.Now().UnixMilli(), Sources: []SrcInfo{}, Objects: []ObjOut{}}
	for i, s := range srcs {
		s.mu.RLock()
		info := SrcInfo{PID: s.t.PID, Map: s.t.Map, Partition: s.t.Partition, Ready: s.ready, Count: len(s.objs),
			Scans: s.scans, ScanMs: s.scanMs, Reason: s.reason, Weather: s.weather}
		if !s.scanAt.IsZero() {
			info.AgeMs = time.Since(s.scanAt).Milliseconds()
		}
		if s.ready {
			for _, o := range s.objs {
				snap.Objects = append(snap.Objects, ObjOut{o.ID, o.Kind, o.Class, i, math.Round(o.X), math.Round(o.Y), math.Round(o.Z), o.Yaw})
			}
		}
		s.mu.RUnlock()
		snap.Sources = append(snap.Sources, info)
	}
	sort.Slice(snap.Objects, func(i, j int) bool { return snap.Objects[i].ID < snap.Objects[j].ID })
	return snap
}

func (a *Agent) publishSnapshot() {
	a.gen.Add(1)
	a.hub.publishSnap(a.snapshot())
}

// Discover führt für alle Prozesse eine Discovery durch und gibt das Ergebnis zurück (Diagnose).
func (a *Agent) Discover(ctx context.Context) Snapshot {
	a.syncTargets(ctx)
	for {
		a.mu.RLock()
		pending := false
		for _, s := range a.sources {
			s.mu.RLock()
			if !s.ready && s.scans == 0 && s.reason == "wird gesucht" {
				pending = true
			}
			s.mu.RUnlock()
		}
		a.mu.RUnlock()
		if !pending {
			break
		}
		select {
		case <-ctx.Done():
			return a.snapshot()
		case <-time.After(200 * time.Millisecond):
		}
	}
	return a.snapshot()
}
