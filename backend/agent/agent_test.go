package agent

import (
	"encoding/binary"
	"math"
	"testing"
)

// fakeMem ist ein Prozessspeicher aus einzelnen Stücken.
type fakeMem struct{ segs map[uint64][]byte }

func newFake() *fakeMem { return &fakeMem{segs: map[uint64][]byte{}} }

func (m *fakeMem) seg(addr uint64, size int) []byte {
	b := make([]byte, size)
	m.segs[addr] = b
	return b
}

func (m *fakeMem) ReadAt(p []byte, off int64) (int, error) {
	for base, b := range m.segs {
		if uint64(off) >= base && uint64(off) < base+uint64(len(b)) {
			n := copy(p, b[uint64(off)-base:])
			if n < len(p) {
				return n, errNoMem
			}
			return n, nil
		}
	}
	return 0, errNoMem
}

var errNoMem = &memErr{}

type memErr struct{}

func (*memErr) Error() string { return "input/output error" }

func put64(b []byte, off int, v uint64) { binary.LittleEndian.PutUint64(b[off:], v) }
func put32(b []byte, off int, v uint32) { binary.LittleEndian.PutUint32(b[off:], v) }
func putF(b []byte, off int, v float64) { put64(b, off, math.Float64bits(v)) }

// world baut: Namenspool (Block 0 bei 0x10000, Zeigerfeld bei 0x20000), eine
// Klasse "BP_Crea_SandwormArrakis_C" bei 0x31000, einen Actor bei 0x30000 (Vtable
// 0x5000) mit RootComponent bei 0x32000.
func world(rootOff, posOff int) (*fakeMem, uint64) {
	m := newFake()
	blk := m.seg(0x10000, 0x200)
	copy(blk[0:], []byte{0x1E, 0x01})
	copy(blk[2:], "None")
	copy(blk[6:], []byte{0x10, 0x03})
	copy(blk[8:], "ByteProperty")
	// Eintrag bei Offset 20 = Index 10: "BP_Crea_SandwormArrakis_C" (25 Zeichen)
	name := "BP_Crea_SandwormArrakis_C"
	binary.LittleEndian.PutUint16(blk[20:], uint16(len(name))<<6)
	copy(blk[22:], name)
	// Index 40 (Offset 80): "Worm_1"
	binary.LittleEndian.PutUint16(blk[80:], uint16(6)<<6)
	copy(blk[82:], "Worm_1")
	put64(m.seg(0x20000, 16), 0, 0x10000)

	cls := m.seg(0x31000, 0x40)
	put32(cls, offName, 10)
	act := m.seg(0x30000, 0x800)
	put64(act, 0, 0x5000)
	put32(act, offFlags, 0)
	put64(act, offClass, 0x31000)
	put32(act, offName, 40)
	put32(act, offName+4, 3) // Nummer 3 → "_2"
	put64(act, rootOff, 0x32000)
	root := m.seg(0x32000, 0x400)
	putF(root, posOff, 245471)
	putF(root, posOff+8, -8007)
	putF(root, posOff+16, -2377)
	return m, 0x30000
}

func TestPoolNames(t *testing.T) {
	m, _ := world(0x238, 0x190)
	p := NewPool(m, 0x20000)
	if !p.Check() {
		t.Fatal("Selbsttest des Pools schlägt fehl")
	}
	if n, ok := p.Name(10, 0); !ok || n != "BP_Crea_SandwormArrakis_C" {
		t.Fatalf("Name(10) = %q %v", n, ok)
	}
	if n, _ := p.Name(40, 3); n != "Worm_1_2" {
		t.Fatalf("FName mit Nummer: %q", n)
	}
	if NewPool(m, 0x99999).Check() {
		t.Fatal("falscher Offset darf den Selbsttest nicht bestehen")
	}
}

func testSource(m Mem) *source {
	a := New(Config{})
	s := newSource(a, Target{Map: "Survival_1", Partition: 1})
	s.mem = m
	s.pool = NewPool(m, 0x20000)
	s.vt = map[uint64]string{0x5000: "ASandwormPawn"}
	return s
}

func TestValidateAndTrack(t *testing.T) {
	m, addr := world(0x238, 0x190)
	s := testSource(m)
	hits := map[uint64][]uint64{0x5000: {addr, 0x77777}} // zweiter Treffer: Geist (nicht lesbar)
	found := s.validate(hits, DefaultOffsets)
	if len(found) != 1 {
		t.Fatalf("erwartet 1 Objekt, bekam %d", len(found))
	}
	o := found[addr]
	if o.Kind != "worm" || o.Class != "BP_Crea_SandwormArrakis_C" || o.X != 245471 || o.Y != -8007 {
		t.Fatalf("falsches Objekt: %+v", o)
	}
	// Default-Objekt (RF_ClassDefaultObject) und freigegebenes Objekt werden verworfen
	for _, fl := range []uint32{rfClassDefault, rfBeginDestroyed, rfFinishDestroy} {
		put32(m.segs[addr], offFlags, fl)
		if len(s.validate(hits, DefaultOffsets)) != 0 {
			t.Fatalf("Flags %#x müssen verworfen werden", fl)
		}
	}
	put32(m.segs[addr], offFlags, 0)
	// Position (0,0) ist keine Position
	putF(m.segs[0x32000], 0x190, 0)
	putF(m.segs[0x32000], 0x198, 0)
	if len(s.validate(hits, DefaultOffsets)) != 0 {
		t.Fatal("Position (0,0) muss verworfen werden")
	}
}

func TestScanVtables(t *testing.T) {
	m, addr := world(0x238, 0x190)
	got := scanVtables(m, []Region{{Start: 0x30000, End: 0x30800}}, 2, map[uint64]string{0x5000: "ASandwormPawn"})
	if len(got[0x5000]) != 1 || got[0x5000][0] != addr {
		t.Fatalf("Treffer: %v", got)
	}
}

func TestCalibrateNewBuild(t *testing.T) {
	// Ein neuer Build mit anderen Offsets: der Agent bestimmt sie selbst neu.
	m, addr := world(0x250, 0x1A8)
	// weitere Actors, damit die Stichprobe groß genug ist
	for i := 1; i <= 20; i++ {
		a := 0x40000 + uint64(i)*0x2000
		act := m.seg(a, 0x800)
		put64(act, 0, 0x5000)
		put64(act, offClass, 0x31000)
		put32(act, offName, 40)
		put64(act, 0x250, a+0x800)
		rc := m.seg(a+0x800, 0x400)
		// Komponentenklasse "…Component" nötig: Klasse des Roots zeigt auf eine Komponentenklasse
		put64(rc, offClass, 0x33000)
		putF(rc, 0x1A8, float64(1000*i))
		putF(rc, 0x1B0, float64(2000*i))
		putF(rc, 0x1B8, 50)
	}
	// Komponentenklasse
	blk := m.segs[0x10000]
	binary.LittleEndian.PutUint16(blk[120:], uint16(16)<<6)
	copy(blk[122:], "CapsuleComponent")
	cc := m.seg(0x33000, 0x40)
	put32(cc, offName, 60) // Offset 120 = Index 60
	// der Haupt-Actor: Root-Komponente bekommt ebenfalls die Komponentenklasse
	put64(m.segs[0x32000], offClass, 0x33000)
	s := testSource(m)
	hits := map[uint64][]uint64{0x5000: {addr}}
	for i := 1; i <= 20; i++ {
		hits[0x5000] = append(hits[0x5000], 0x40000+uint64(i)*0x2000)
	}
	if len(s.validate(hits, DefaultOffsets)) != 0 {
		t.Fatal("mit alten Offsets darf nichts plausibel sein")
	}
	o, ok := s.calibrate(hits, DefaultOffsets)
	if !ok || o.Root != 0x250 || o.Pos != 0x1A8 {
		t.Fatalf("Kalibrierung: %+v %v", o, ok)
	}
	if got := len(s.validate(hits, o)); got != 21 {
		t.Fatalf("mit neuen Offsets %d statt 21 Objekte", got)
	}
}

func TestFindPool(t *testing.T) {
	m, _ := world(0x238, 0x190)
	got := findPoolBlock(m, []Region{{Start: 0x10000, End: 0x10200}}, 2)
	if len(got) != 1 || got[0] != 0x10000 {
		t.Fatalf("Signatur: %v", got)
	}
	ptrs := findPointersTo(m, []Region{{Start: 0x20000, End: 0x20010}}, 2, 0x10000)
	if len(ptrs) != 1 || ptrs[0] != 0x20000 {
		t.Fatalf("Zeiger: %v", ptrs)
	}
}

func TestMergeKeepsIDs(t *testing.T) {
	m, addr := world(0x238, 0x190)
	s := testSource(m)
	hits := map[uint64][]uint64{0x5000: {addr}}
	s.merge(s.validate(hits, DefaultOffsets))
	var id uint32
	for k := range s.objs {
		id = k
	}
	s.merge(s.validate(hits, DefaultOffsets))
	if _, ok := s.objs[id]; !ok || len(s.objs) != 1 {
		t.Fatal("dasselbe Objekt muss seine ID behalten")
	}
	s.merge(map[uint64]*Obj{})
	if len(s.objs) != 0 || len(s.removed) != 1 || s.removed[0] != id {
		t.Fatalf("verschwundenes Objekt: %v %v", s.objs, s.removed)
	}
}

func TestParse(t *testing.T) {
	if c, ok := demangleVtable("_ZTV17ADuneNpcCharacter"); !ok || c != "ADuneNpcCharacter" {
		t.Fatal("demangle")
	}
	for _, bad := range []string{"_ZTVN3foo3barE", "_ZTV5Short9", "_ZTV", "main"} {
		if _, ok := demangleVtable(bad); ok {
			t.Fatalf("%q darf nicht passen", bad)
		}
	}
	tg, ok := parseCmdline([]byte("/home/dune/server/DuneSandbox/Binaries/Linux/DuneSandboxServer-Linux-Shipping\x00DuneSandbox\x00Survival_1\x00-FarmRegion=Europe\x00-PartitionIndex=31\x00"))
	if !ok || tg.Map != "Survival_1" || tg.Partition != 31 {
		t.Fatalf("cmdline: %+v %v", tg, ok)
	}
	if _, ok := parseCmdline([]byte("/bin/sh\x00/home/dune/server/DuneSandboxServer.sh\x00Survival_1\x00")); ok {
		t.Fatal("Startskript ist kein Map-Prozess")
	}
	r, ok := parseMapsLine("5cb9dfa9d000-5cb9f4e34000 r-xp 00000000 08:01 1234  /home/dune/server/DuneSandbox/Binaries/Linux/DuneSandboxServer-Linux-Shipping")
	if !ok || r.Start != 0x5cb9dfa9d000 || r.Perms != "r-xp" {
		t.Fatalf("maps: %+v", r)
	}
	regs := []Region{r, {Start: 0x5cb9f5000000, End: 0x5cb9f6000000, Perms: "rw-p", Offset: 0x15563000, Path: r.Path}}
	if b, ok := moduleBase(regs); !ok || b != 0x5cb9dfa9d000 {
		t.Fatalf("Modulbasis %#x", b)
	}
}

func TestPlausibleWorld(t *testing.T) {
	good := [][3]float64{{245471, -8007, -2377}, {-1022958, -747493, 534}}
	bad := [][3]float64{{0, 0, 0}, {math.NaN(), 1, 1}, {1e9, 1, 1}, {1, math.Inf(1), 1}}
	for _, g := range good {
		if !plausibleWorld(g[0], g[1], g[2]) {
			t.Errorf("%v soll plausibel sein", g)
		}
	}
	for _, b := range bad {
		if plausibleWorld(b[0], b[1], b[2]) {
			t.Errorf("%v soll unplausibel sein", b)
		}
	}
}

// ── Stürme und Coriolis ────────────────────────────────────────────────────

func ticks(unixSec int64) int64 { return (unixSec + 62135596800) * 10_000_000 }

func TestReadWeather(t *testing.T) {
	m := newFake()
	sub := m.seg(0x40000, 0x400)
	put64(sub, 0, 0x6000)
	put32(sub, offFlags, 0)
	// 2026-09-29 05:00 UTC und 2026-10-06 05:00 UTC an einem beliebigen Offset
	put64(sub, 0xB0, uint64(ticks(1790571600)))
	put64(sub, 0xB8, uint64(ticks(1791176400)))
	s := testSource(m)
	s.vtSub = 0x6000
	s.readWeather(map[uint64][]uint64{0x6000: {0x40000}})
	if s.weather == nil || s.weather.CoriolisStart != 1790571600*1000 || s.weather.CoriolisNext != 1791176400*1000 {
		t.Fatalf("Zeitplan falsch: %+v", s.weather)
	}
	// Default-Objekt liefert nichts
	s.weather = nil
	put32(sub, offFlags, rfClassDefault)
	s.readWeather(map[uint64][]uint64{0x6000: {0x40000}})
	if s.weather != nil {
		t.Fatal("Default-Objekt darf keinen Zeitplan liefern")
	}
	// Zufallsdaten (kein gültiges Paar) ergeben keinen Zeitplan
	put32(sub, offFlags, 0)
	put64(sub, 0xB0, 12345)
	put64(sub, 0xB8, 67890)
	s.readWeather(map[uint64][]uint64{0x6000: {0x40000}})
	if s.weather != nil {
		t.Fatalf("ungültige Werte dürfen nicht als Zeitplan gelten: %+v", s.weather)
	}
}

func TestReadYaw(t *testing.T) {
	m := newFake()
	root := m.seg(0x50000, 0x400)
	s := testSource(m)
	// 90° um Z: (0,0,sin45,cos45) → Yaw 90
	putF(root, offRot, 0)
	putF(root, offRot+8, 0)
	putF(root, offRot+16, math.Sin(math.Pi/4))
	putF(root, offRot+24, math.Cos(math.Pi/4))
	if y := s.readYaw(0x50000); math.Abs(y-90) > 0.1 {
		t.Fatalf("Yaw = %v, erwartet 90", y)
	}
	// kein Einheitsquaternion → 0
	putF(root, offRot+24, 3)
	if y := s.readYaw(0x50000); y != 0 {
		t.Fatalf("ungültiges Quaternion muss 0 ergeben, bekam %v", y)
	}
}

func TestMergeStormsKeepsOthers(t *testing.T) {
	m, _ := world(0x238, 0x190)
	s := testSource(m)
	worm := &Obj{ID: 1, Addr: 0x30000, Kind: "worm", Vtab: 0x5000}
	oldStorm := &Obj{ID: 2, Addr: 0x99000, Kind: "storm", Vtab: 0x7000, Root: 1}
	s.a.nextID.Store(10)
	s.objs = map[uint32]*Obj{1: worm, 2: oldStorm}
	newStorm := &Obj{Addr: 0x98000, Kind: "storm", Vtab: 0x7000, Root: 2, X: 5, Y: 6}
	if !s.mergeStorms(map[uint64]*Obj{0x98000: newStorm}) {
		t.Fatal("Änderung nicht erkannt")
	}
	if s.objs[1] == nil || s.objs[2] != nil || s.objs[11] == nil || len(s.objs) != 2 {
		t.Fatalf("Würmer müssen bleiben, alter Sturm weg, neuer da: %+v", s.objs)
	}
	if len(s.removed) != 1 || s.removed[0] != 2 {
		t.Fatalf("entfernter Sturm fehlt in removed: %v", s.removed)
	}
	// unveränderter Stand: keine Änderung
	if s.mergeStorms(map[uint64]*Obj{0x98000: {Addr: 0x98000, Kind: "storm", Vtab: 0x7000, Root: 2, X: 7, Y: 8}}) {
		t.Fatal("gleicher Sturm darf nicht als Änderung gelten")
	}
}
