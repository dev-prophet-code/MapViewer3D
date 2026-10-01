package agent

import (
	"debug/elf"
	"encoding/binary"
	"fmt"
	"io"
	"math"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
)

// Probe ist ein Diagnosewerkzeug (mvagent -probe): Es sucht alle Klassen, deren
// Vtable-Symbol zum Muster passt (z. B. "Storm|Coriolis"), listet ihre Instanzen und
// zeigt die Felder des Actors (Zeiger auf bekannte Objekte, Doubles, Floats),
// damit man unbekannte Objekte wie Sandstürme erkunden kann. Nur lesend.
func Probe(procRoot string, pid int, pattern string, dumpLen int, offs Offsets, w io.Writer) error {
	re, err := regexp.Compile(pattern)
	if err != nil {
		return err
	}
	a := New(Config{ProcRoot: procRoot, Workers: 4, Offsets: offs})
	s := newSource(a, Target{PID: pid, Partition: -1})
	if err := s.open(); err != nil {
		return err
	}
	defer s.close()
	regs, err := readMaps(procRoot, pid)
	if err != nil {
		return err
	}
	base, ok := moduleBase(regs)
	if !ok {
		return fmt.Errorf("Modulbasis nicht gefunden")
	}
	s.base = base
	s.pool = NewPool(s.mem, base+offs.Blocks)
	if !s.pool.Check() {
		return fmt.Errorf("FNamePool-Offset passt nicht")
	}
	f, err := elf.Open(filepath.Join(procRoot, strconv.Itoa(pid), "exe"))
	if err != nil {
		return err
	}
	defer f.Close()
	syms, err := f.DynamicSymbols()
	if err != nil {
		return err
	}
	vt := map[uint64]string{}
	for _, sym := range syms {
		if cls, ok := demangleVtable(sym.Name); ok && sym.Value != 0 && re.MatchString(cls) {
			vt[base+sym.Value+0x10] = cls
		}
	}
	names := make([]string, 0, len(vt))
	for _, c := range vt {
		names = append(names, c)
	}
	sort.Strings(names)
	fmt.Fprintf(w, "Vtable-Symbole zum Muster %q: %d\n", pattern, len(names))
	for _, n := range names {
		fmt.Fprintf(w, "  %s\n", n)
	}
	if len(vt) == 0 {
		return nil
	}
	hits := scanVtables(s.mem, heapRegions(regs), 4, vt)
	for v, addrs := range hits {
		fmt.Fprintf(w, "\n== %s: %d Treffer\n", vt[v], len(addrs))
		for _, addr := range addrs {
			s.dumpActor(w, addr, v, dumpLen, offs)
		}
	}
	return nil
}

func (s *source) dumpActor(w io.Writer, addr, vtab uint64, dumpLen int, offs Offsets) {
	ai, ok := readActor(s.mem, addr, offs.Root)
	if !ok {
		fmt.Fprintf(w, "  0x%X: nicht lesbar\n", addr)
		return
	}
	cls := s.className(ai.class)
	name, _ := s.pool.Name(ai.name[0], ai.name[1])
	state := "Instanz"
	if ai.flags&(rfClassDefault|rfBeginDestroyed|rfFinishDestroy) != 0 {
		state = fmt.Sprintf("Geist/Default (flags 0x%X)", ai.flags)
	}
	fmt.Fprintf(w, "  0x%X  class=%q name=%q  %s\n", addr, cls, name, state)
	if x, y, z, ok := readVec(s.mem, ai.root, offs.Pos); ok {
		fmt.Fprintf(w, "    Position (Root+0x%X): %.0f %.0f %.0f cm  yaw=%.1f\n", offs.Pos, x, y, z, s.readYaw(ai.root))
	}
	if state == "Instanz" {
		rb := make([]byte, 0x300)
		n, _ := s.mem.ReadAt(rb, int64(ai.root))
		d := func(o int) float64 { return math.Float64frombits(binary.LittleEndian.Uint64(rb[o:])) }
		if n >= 0x2E0 {
			fmt.Fprintf(w, "    ComponentToWorld: T(+0x2B0)=%.0f %.0f %.0f  S(+0x2C8)=%.3f %.3f %.3f\n", d(0x2B0), d(0x2B8), d(0x2C0), d(0x2C8), d(0x2D0), d(0x2D8))
		}
		for o := 0x100; o+32 <= n && o < 0x2C0; o += 8 {
			q := [4]float64{d(o), d(o + 8), d(o + 16), d(o + 24)}
			nn := math.Sqrt(q[0]*q[0] + q[1]*q[1] + q[2]*q[2] + q[3]*q[3])
			if math.Abs(nn-1) < 1e-6 {
				fmt.Fprintf(w, "    Quaternion @Root+0x%X: %.4f %.4f %.4f %.4f\n", o, q[0], q[1], q[2], q[3])
			}
		}
	}
	if state != "Instanz" || dumpLen <= 0 {
		return
	}
	buf := make([]byte, dumpLen)
	n, _ := s.mem.ReadAt(buf, int64(addr))
	for off := 0; off+8 <= n; off += 8 {
		q := binary.LittleEndian.Uint64(buf[off:])
		if q == 0 {
			continue
		}
		var desc string
		if plausiblePtr(q) {
			if t, ok := readActor(s.mem, q, 0x28); ok {
				if c := s.className(t.class); c != "" {
					tn, _ := s.pool.Name(t.name[0], t.name[1])
					desc = fmt.Sprintf("-> %s %q", c, tn)
				}
			}
		}
		if d := math.Float64frombits(q); desc == "" && !math.IsNaN(d) && math.Abs(d) > 1e-3 && math.Abs(d) < 1e9 {
			desc = fmt.Sprintf("double %.4f", d)
		}
		if desc == "" {
			lo := math.Float32frombits(uint32(q))
			hi := math.Float32frombits(uint32(q >> 32))
			okf := func(v float32) bool {
				return !math.IsNaN(float64(v)) && math.Abs(float64(v)) > 1e-3 && math.Abs(float64(v)) < 1e8
			}
			if okf(lo) || okf(hi) {
				desc = fmt.Sprintf("float %.4f | %.4f  (u32 %d | %d)", lo, hi, uint32(q), uint32(q>>32))
			}
		}
		if desc != "" {
			fmt.Fprintf(w, "    +0x%03X  %016X  %s\n", off, q, desc)
		}
	}
}
