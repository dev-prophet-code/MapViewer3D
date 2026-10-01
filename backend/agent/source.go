package agent

import (
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// errNoActors: Treffer ohne ein plausibles Objekt (Overmap hat keine Akteure mit Position).
var errNoActors = errors.New("kein plausibles Objekt")

// Obj ist ein gefundenes Spielobjekt.
type Obj struct {
	ID      uint32
	Addr    uint64
	Root    uint64
	Vtab    uint64
	Kind    string // npc, civilian, worm, vehicle, player
	Class   string // Blueprint-Name, z. B. BP_Crea_SandwormArrakis_C
	X, Y, Z float64
	moved   time.Time
}

// source ist ein Map-Prozess.
type source struct {
	t      Target
	a      *Agent
	mem    Mem
	file   *os.File
	base   uint64
	pool   *Pool
	vt     map[uint64]string // Laufzeit-Vtable → Klasse
	cancel chan struct{}
	rescan chan struct{}

	mu      sync.RWMutex
	objs    map[uint32]*Obj
	ready   bool
	reason  string
	scans   int
	scanMs  int64
	scanAt  time.Time
	removed []uint32
	fast    []uint32 // IDs, die mit voller Rate gelesen werden (aktive Objekte)
	classMu sync.Mutex
	classes map[uint64]string
}

func newSource(a *Agent, t Target) *source {
	return &source{t: t, a: a, cancel: make(chan struct{}), rescan: make(chan struct{}, 1),
		objs: map[uint32]*Obj{}, classes: map[uint64]string{}, reason: "wird gesucht"}
}

func (s *source) label() string {
	return fmt.Sprintf("%s pid=%d partition=%d", s.t.Map, s.t.PID, s.t.Partition)
}

func (s *source) setReason(r string) {
	s.mu.Lock()
	s.ready, s.reason = false, r
	s.mu.Unlock()
}

// requestRescan stößt eine neue Discovery an (höchstens alle RescanMin).
func (s *source) requestRescan() {
	select {
	case s.rescan <- struct{}{}:
	default:
	}
}

func (s *source) open() error {
	if s.mem != nil {
		return nil
	}
	f, err := os.Open(filepath.Join(s.a.cfg.ProcRoot, strconv.Itoa(s.t.PID), "mem"))
	if err != nil {
		return err
	}
	s.file, s.mem = f, f
	return nil
}

func (s *source) close() {
	if s.file != nil {
		s.file.Close()
	}
}

// className löst den Namen einer UClass auf (zwischengespeichert).
func (s *source) className(class uint64) string {
	s.classMu.Lock()
	defer s.classMu.Unlock()
	if n, ok := s.classes[class]; ok {
		return n
	}
	name := ""
	if plausiblePtr(class) {
		var b [8]byte
		if n, _ := s.mem.ReadAt(b[:], int64(class+offName)); n == 8 {
			idx := uint32(b[0]) | uint32(b[1])<<8 | uint32(b[2])<<16 | uint32(b[3])<<24
			num := uint32(b[4]) | uint32(b[5])<<8 | uint32(b[6])<<16 | uint32(b[7])<<24
			if nm, ok := s.pool.Name(idx, num); ok && len(nm) <= 80 {
				name = nm
			}
		}
	}
	s.classes[class] = name
	return name
}

// scan führt die Discovery durch und gleicht das Ergebnis mit den bekannten Objekten ab.
func (s *source) scan() error {
	if err := s.open(); err != nil {
		return fmt.Errorf("Speicher nicht lesbar (root nötig): %w", err)
	}
	t0 := time.Now()
	regs, err := readMaps(s.a.cfg.ProcRoot, s.t.PID)
	if err != nil {
		return err
	}
	base, ok := moduleBase(regs)
	if !ok {
		return fmt.Errorf("Modulbasis nicht gefunden")
	}
	s.base = base
	exe := filepath.Join(s.a.cfg.ProcRoot, strconv.Itoa(s.t.PID), "exe")
	addrs, err := s.a.vtables(exe)
	if err != nil {
		return err
	}
	s.vt = map[uint64]string{}
	for cls, v := range addrs {
		if cls == "ADunePlayerCharacter" && !s.a.cfg.Players {
			continue
		}
		s.vt[base+v+0x10] = cls
	}
	heap := heapRegions(regs)

	// FNamePool: Standard-Offset, sonst aus dem Speicher bestimmen (neuer Build)
	offs := s.a.offsets()
	s.pool = NewPool(s.mem, base+offs.Blocks)
	if !s.pool.Check() {
		blocks, err := s.findPool(regs, heap)
		if err != nil {
			return fmt.Errorf("FNamePool-Offset passt nicht zu diesem Build: %w", err)
		}
		offs.Blocks = blocks
		s.a.setOffsets(offs)
		s.pool = NewPool(s.mem, base+blocks)
		log.Printf("[%s] FNamePool neu bestimmt: Blocks=0x%X", s.label(), blocks)
	}
	s.classMu.Lock()
	s.classes = map[uint64]string{}
	s.classMu.Unlock()

	hits := scanVtables(s.mem, heap, s.a.cfg.Workers, s.vt)
	nHits := 0
	for _, h := range hits {
		nHits += len(h)
	}
	found := s.validate(hits, offs)
	if len(found) == 0 && nHits > 0 {
		if o, ok := s.calibrate(hits, offs); ok {
			offs = o
			s.a.setOffsets(o)
			log.Printf("[%s] Offsets neu bestimmt: Root=0x%X Pos=0x%X", s.label(), o.Root, o.Pos)
			found = s.validate(hits, offs)
		}
	}
	if len(found) == 0 && nHits > 0 {
		return fmt.Errorf("%w (%d Vtable-Treffer; bei Overmap normal, sonst passen die Offsets nicht zu diesem Build)", errNoActors, nHits)
	}
	s.merge(found)
	s.mu.Lock()
	s.ready, s.reason = true, ""
	s.scans++
	s.scanMs = time.Since(t0).Milliseconds()
	s.scanAt = time.Now()
	n := len(s.objs)
	s.mu.Unlock()
	log.Printf("[%s] Discovery: %d Treffer, %d Objekte, %d ms", s.label(), nHits, n, time.Since(t0).Milliseconds())
	return nil
}

// findPool bestimmt den Offset des FNamePool-Zeigerfelds aus der Signatur von Block 0.
func (s *source) findPool(regs, heap []Region) (uint64, error) {
	cands := findPoolBlock(s.mem, heap, s.a.cfg.Workers)
	if len(cands) == 0 {
		return 0, fmt.Errorf("Signatur von Block 0 nicht gefunden (Prozess noch im Start?)")
	}
	mod := moduleRegions(regs, s.base)
	for _, c := range cands {
		for _, p := range findPointersTo(s.mem, mod, s.a.cfg.Workers, c) {
			if NewPool(s.mem, p).Check() {
				return p - s.base, nil
			}
		}
	}
	return 0, fmt.Errorf("kein Zeiger auf den Namensblock gefunden")
}

// validate prüft jeden Vtable-Treffer (Plausibilitätsfilter) und baut die Objekte.
func (s *source) validate(hits map[uint64][]uint64, offs Offsets) map[uint64]*Obj {
	out := map[uint64]*Obj{}
	for vtab, addrs := range hits {
		cls := s.vt[vtab]
		kind := classKinds[cls]
		for _, addr := range addrs {
			if o := s.build(addr, vtab, kind, offs); o != nil {
				out[addr] = o
			}
		}
	}
	return out
}

func (s *source) build(addr, vtab uint64, kind string, offs Offsets) *Obj {
	ai, ok := readActor(s.mem, addr, offs.Root)
	if !ok || ai.vtab != vtab || ai.flags&(rfClassDefault|rfBeginDestroyed|rfFinishDestroy) != 0 || !plausiblePtr(ai.root) {
		return nil
	}
	cls := s.className(ai.class)
	if cls == "" {
		return nil
	}
	name, ok := s.pool.Name(ai.name[0], ai.name[1])
	if !ok || strings.HasPrefix(name, "Default__") {
		return nil
	}
	x, y, z, ok := readVec(s.mem, ai.root, offs.Pos)
	if !ok {
		return nil
	}
	return &Obj{Addr: addr, Root: ai.root, Vtab: vtab, Kind: kind, Class: cls, X: x, Y: y, Z: z, moved: time.Time{}}
}

// calibrate bestimmt RootComponent- und Positionsoffset neu (Methode aus der Anleitung,
// Abschnitt 8): Zeiger auf ein Objekt, dessen Klasse "…Component" heißt, und darin
// drei aufeinanderfolgende double, die wie Weltkoordinaten aussehen.
func (s *source) calibrate(hits map[uint64][]uint64, offs Offsets) (Offsets, bool) {
	var sample []uint64
	for _, addrs := range hits {
		for _, a := range addrs {
			if len(sample) < 300 {
				sample = append(sample, a)
			}
		}
	}
	if len(sample) < 10 {
		return offs, false
	}
	bestRoot, bestN := uint64(0), 0
	for r := uint64(0x100); r <= 0x600; r += 8 {
		n := 0
		for _, a := range sample {
			ai, ok := readActor(s.mem, a, r)
			if ok && plausiblePtr(ai.root) {
				if rc, ok := readActor(s.mem, ai.root, 0x28); ok && strings.HasSuffix(s.className(rc.class), "Component") {
					n++
				}
			}
		}
		if n > bestN {
			bestRoot, bestN = r, n
		}
	}
	if bestN*2 < len(sample) {
		return offs, false
	}
	bestPos, bestP := uint64(0), 0
	for p := uint64(0x100); p <= 0x400; p += 8 {
		n := 0
		for _, a := range sample {
			ai, ok := readActor(s.mem, a, bestRoot)
			if !ok || !plausiblePtr(ai.root) {
				continue
			}
			if _, _, _, ok := readVec(s.mem, ai.root, p); ok {
				n++
			}
		}
		if n > bestP {
			bestPos, bestP = p, n
		}
	}
	if bestP*2 < len(sample) {
		return offs, false
	}
	return Offsets{Blocks: offs.Blocks, Root: bestRoot, Pos: bestPos}, true
}

// rebuildFast legt fest, welche Objekte mit voller Rate gelesen werden: alles außer
// stehenden Gegnern und Zivilisten. Der Aufrufer hält s.mu.
func (s *source) rebuildFast(now time.Time) {
	s.fast = s.fast[:0]
	for id, o := range s.objs {
		if !isNPC(o.Kind) || now.Sub(o.moved) < activeFor {
			s.fast = append(s.fast, id)
		}
	}
}

// merge gleicht die Discovery mit den bekannten Objekten ab: gleiche Objekte behalten ihre ID.
func (s *source) merge(found map[uint64]*Obj) {
	s.mu.Lock()
	defer s.mu.Unlock()
	byAddr := map[uint64]*Obj{}
	for _, o := range s.objs {
		byAddr[o.Addr] = o
	}
	next := make(map[uint32]*Obj, len(found))
	for addr, n := range found {
		if old, ok := byAddr[addr]; ok && old.Vtab == n.Vtab && old.Root == n.Root {
			old.X, old.Y, old.Z = n.X, n.Y, n.Z
			next[old.ID] = old
			delete(byAddr, addr)
			continue
		}
		n.ID = s.a.nextID.Add(1)
		next[n.ID] = n
	}
	for _, o := range s.objs {
		if _, kept := next[o.ID]; !kept {
			s.removed = append(s.removed, o.ID)
		}
	}
	s.objs = next
	s.rebuildFast(time.Now())
}
