package agent

import (
	"bufio"
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const shippingBinary = "DuneSandboxServer-Linux-Shipping"

// Target ist ein laufender Map-Prozess (ein Spielserver).
type Target struct {
	PID       int
	Start     uint64 // Startzeit in Ticks (erkennt PID-Wiederverwendung)
	Map       string // z. B. Survival_1, DeepDesert_1
	Partition int    // -PartitionIndex, -1 = unbekannt
}

func (t Target) key() string { return fmt.Sprintf("%d/%d", t.PID, t.Start) }

// findTargets listet alle Map-Prozesse im Host-/proc. Es zählt nur der Prozess
// der Shipping-Binary selbst, nicht die Startskripte (sh, su) davor.
// Die Kommandozeile enthält einen Auth-Token: sie wird nie ausgegeben.
func findTargets(procRoot string) []Target {
	ents, _ := os.ReadDir(procRoot)
	var out []Target
	for _, e := range ents {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(procRoot, e.Name(), "cmdline"))
		if err != nil || len(raw) == 0 {
			continue
		}
		if t, ok := parseCmdline(raw); ok {
			t.PID = pid
			t.Start = procStart(procRoot, pid)
			out = append(out, t)
		}
	}
	return out
}

func parseCmdline(raw []byte) (Target, bool) {
	args := strings.Split(strings.TrimRight(string(raw), "\x00"), "\x00")
	if len(args) < 3 || filepath.Base(args[0]) != shippingBinary || args[1] != "DuneSandbox" {
		return Target{}, false
	}
	t := Target{Map: args[2], Partition: -1}
	for _, a := range args[3:] {
		if v, ok := strings.CutPrefix(a, "-PartitionIndex="); ok {
			if n, err := strconv.Atoi(v); err == nil {
				t.Partition = n
			}
		}
	}
	return t, true
}

// procStart liest die Startzeit (Feld 22 von /proc/<pid>/stat).
func procStart(procRoot string, pid int) uint64 {
	b, err := os.ReadFile(filepath.Join(procRoot, strconv.Itoa(pid), "stat"))
	if err != nil {
		return 0
	}
	// Der Prozessname steht in Klammern und kann Leerzeichen enthalten
	i := bytes.LastIndexByte(b, ')')
	if i < 0 {
		return 0
	}
	f := strings.Fields(string(b[i+1:]))
	if len(f) < 20 {
		return 0
	}
	v, _ := strconv.ParseUint(f[19], 10, 64)
	return v
}

// Region ist ein Speicherbereich aus /proc/<pid>/maps.
type Region struct {
	Start, End uint64
	Perms      string
	Offset     uint64
	Path       string
}

func readMaps(procRoot string, pid int) ([]Region, error) {
	f, err := os.Open(filepath.Join(procRoot, strconv.Itoa(pid), "maps"))
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var out []Region
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<16), 1<<20)
	for sc.Scan() {
		if r, ok := parseMapsLine(sc.Text()); ok {
			out = append(out, r)
		}
	}
	return out, sc.Err()
}

func parseMapsLine(line string) (Region, bool) {
	f := strings.Fields(line)
	if len(f) < 5 {
		return Region{}, false
	}
	span := strings.SplitN(f[0], "-", 2)
	if len(span) != 2 {
		return Region{}, false
	}
	s, e1 := strconv.ParseUint(span[0], 16, 64)
	e, e2 := strconv.ParseUint(span[1], 16, 64)
	off, e3 := strconv.ParseUint(f[2], 16, 64)
	if e1 != nil || e2 != nil || e3 != nil {
		return Region{}, false
	}
	r := Region{Start: s, End: e, Perms: f[1], Offset: off}
	if len(f) >= 6 {
		r.Path = strings.Join(f[5:], " ")
	}
	return r, true
}

// moduleBase ist die Ladeadresse der Binary (ASLR): die kleinste
// Startadresse minus Datei-Offset aller Zeilen, die zur Binary gehören.
func moduleBase(regs []Region) (uint64, bool) {
	var base uint64
	found := false
	for _, r := range regs {
		if filepath.Base(r.Path) != shippingBinary || r.Start < r.Offset {
			continue
		}
		if b := r.Start - r.Offset; !found || b < base {
			base, found = b, true
		}
	}
	return base, found
}

// heapRegions sind die Bereiche, in denen Spielobjekte liegen: beschreibbarer,
// privater Speicher ohne Datei (Heap und anonyme Zuordnungen).
func heapRegions(regs []Region) []Region {
	var out []Region
	for _, r := range regs {
		if len(r.Perms) < 4 || r.Perms[0] != 'r' || r.Perms[1] != 'w' || r.Perms[3] != 'p' {
			continue
		}
		if r.Path != "" && r.Path != "[heap]" {
			continue
		}
		out = append(out, r)
	}
	return out
}

// moduleRegions sind die beschreibbaren Bereiche der Binary samt .bss dahinter
// (dort steht der Zeiger auf den FNamePool).
func moduleRegions(regs []Region, base uint64) []Region {
	var out []Region
	for _, r := range regs {
		if len(r.Perms) < 2 || r.Perms[0] != 'r' || r.Perms[1] != 'w' {
			continue
		}
		if r.Start >= base && r.Start < base+0x3000_0000 && (r.Path == "" || filepath.Base(r.Path) == shippingBinary) {
			out = append(out, r)
		}
	}
	return out
}

// GameProcesses zählt die laufenden Map-Prozesse des Spielservers im (Host-)/proc:
// größer 0 heißt, dieser Rechner ist der Spiel-Host (Docker-Container teilen den Prozessraum
// des Hosts, deshalb sieht man sie hier).
func GameProcesses(procRoot string) int { return len(findTargets(procRoot)) }
