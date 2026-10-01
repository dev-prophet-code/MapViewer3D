package agent

import (
	"bytes"
	"encoding/binary"
	"math"
	"sync"
)

const scanChunk = 16 << 20

// scanRegions liest die Bereiche blockweise und ruft fn(Blockanfang, Daten) auf.
// overlap > 0 überlappt die Blöcke (für Bytefolgen statt ausgerichteter Werte).
// Nicht lesbare Stellen (Schutzseiten, gerade freigegebener Speicher) werden
// seitenweise übersprungen. Jeder Worker liest mit eigenem Puffer.
func scanRegions(mem Mem, regs []Region, workers, overlap int, fn func(addr uint64, buf []byte)) {
	type job struct{ start, end uint64 }
	jobs := make(chan job, 64)
	var wg sync.WaitGroup
	if workers < 1 {
		workers = 1
	}
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			buf := make([]byte, scanChunk+overlap)
			for j := range jobs {
				want := int(j.end - j.start)
				if j.end < j.start || want <= 0 {
					continue
				}
				if want > len(buf) {
					want = len(buf)
				}
				readSkipping(mem, j.start, buf[:want], fn)
			}
		}()
	}
	for _, r := range regs {
		for a := r.Start; a < r.End; a += scanChunk {
			e := a + scanChunk + uint64(overlap)
			if e > r.End {
				e = r.End
			}
			jobs <- job{a, e}
		}
	}
	close(jobs)
	wg.Wait()
}

// readSkipping füllt buf ab start; bei einem Lesefehler wird die nächste Seite
// versucht. fn bekommt jeweils die zusammenhängenden gelesenen Stücke.
func readSkipping(mem Mem, start uint64, buf []byte, fn func(uint64, []byte)) {
	off := 0
	for off < len(buf) {
		n, err := mem.ReadAt(buf[off:], int64(start)+int64(off))
		if n > 0 {
			fn(start+uint64(off), buf[off:off+n])
			off += n
		}
		if err == nil {
			return
		}
		off = (off | 0xFFF) + 1 // fehlerhafte Seite überspringen
	}
}

// scanVtables findet alle 8-Byte-ausgerichteten Werte, die auf eine der Vtables zeigen.
func scanVtables(mem Mem, regs []Region, workers int, vt map[uint64]string) map[uint64][]uint64 {
	var lo, hi uint64 = math.MaxUint64, 0
	for v := range vt {
		lo, hi = min(lo, v), max(hi, v)
	}
	var mu sync.Mutex
	hits := map[uint64][]uint64{}
	scanRegions(mem, regs, workers, 0, func(addr uint64, b []byte) {
		var local [][2]uint64
		for i := 0; i+8 <= len(b); i += 8 {
			q := binary.LittleEndian.Uint64(b[i:])
			if q < lo || q > hi {
				continue
			}
			if _, ok := vt[q]; ok {
				local = append(local, [2]uint64{q, addr + uint64(i)})
			}
		}
		if len(local) > 0 {
			mu.Lock()
			for _, h := range local {
				hits[h[0]] = append(hits[h[0]], h[1])
			}
			mu.Unlock()
		}
	})
	return hits
}

// findPoolBlock sucht die Signatur von Block 0 des FNamePools ("None", "ByteProperty").
func findPoolBlock(mem Mem, regs []Region, workers int) []uint64 {
	var mu sync.Mutex
	var out []uint64
	scanRegions(mem, regs, workers, len(poolSignature), func(addr uint64, b []byte) {
		for off := 0; ; {
			i := bytes.Index(b[off:], poolSignature)
			if i < 0 {
				return
			}
			mu.Lock()
			out = append(out, addr+uint64(off+i))
			mu.Unlock()
			off += i + 1
		}
	})
	return out
}

// findPointersTo sucht 8-Byte-Werte, die genau target sind (Zeiger auf Block 0).
func findPointersTo(mem Mem, regs []Region, workers int, target uint64) []uint64 {
	var mu sync.Mutex
	var out []uint64
	var pat [8]byte
	binary.LittleEndian.PutUint64(pat[:], target)
	scanRegions(mem, regs, workers, 0, func(addr uint64, b []byte) {
		for off := 0; off+8 <= len(b); off += 8 {
			if bytes.Equal(b[off:off+8], pat[:]) {
				mu.Lock()
				out = append(out, addr+uint64(off))
				mu.Unlock()
			}
		}
	})
	return out
}

// Offsets sind die buildabhängigen Werte (Standard: Build 2134304).
type Offsets struct {
	Blocks uint64 // FNamePool Blocks[] relativ zur Modulbasis
	Root   uint64 // AActor::RootComponent
	Pos    uint64 // Weltposition (3 × double, cm) im RootComponent
}

var DefaultOffsets = Offsets{Blocks: 0x174125A8, Root: 0x238, Pos: 0x190}

// UObjectBase
const (
	offFlags = 0x08
	offClass = 0x10
	offName  = 0x18

	rfClassDefault   = 0x10
	rfBeginDestroyed = 0x8000
	rfFinishDestroy  = 0x10000
)

// readHeader liest die ersten Bytes eines Actors in einem Zug.
const headerLen = 0x240

type actorInfo struct {
	vtab  uint64
	flags uint32
	class uint64
	name  [2]uint32
	root  uint64
}

func readActor(mem Mem, addr uint64, rootOff uint64) (actorInfo, bool) {
	size := int(rootOff) + 8
	if size < 0x28 {
		size = 0x28
	}
	buf := make([]byte, size)
	if n, _ := mem.ReadAt(buf, int64(addr)); n != size {
		return actorInfo{}, false
	}
	return actorInfo{
		vtab:  binary.LittleEndian.Uint64(buf[0:]),
		flags: binary.LittleEndian.Uint32(buf[offFlags:]),
		class: binary.LittleEndian.Uint64(buf[offClass:]),
		name:  [2]uint32{binary.LittleEndian.Uint32(buf[offName:]), binary.LittleEndian.Uint32(buf[offName+4:])},
		root:  binary.LittleEndian.Uint64(buf[rootOff:]),
	}, true
}

func readVec(mem Mem, root, posOff uint64) (x, y, z float64, ok bool) {
	var b [24]byte
	if n, _ := mem.ReadAt(b[:], int64(root+posOff)); n != 24 {
		return 0, 0, 0, false
	}
	x = math.Float64frombits(binary.LittleEndian.Uint64(b[0:]))
	y = math.Float64frombits(binary.LittleEndian.Uint64(b[8:]))
	z = math.Float64frombits(binary.LittleEndian.Uint64(b[16:]))
	return x, y, z, plausibleWorld(x, y, z)
}

// plausibleWorld: endliche Weltkoordinaten in cm (Beträge 1 bis 3 000 000). Ein Pawn,
// der gerade nicht greifbar ist, steht bei (0,0); das ist keine Position.
func plausibleWorld(x, y, z float64) bool {
	for _, v := range []float64{x, y, z} {
		if math.IsNaN(v) || math.IsInf(v, 0) || math.Abs(v) > 3_000_000 {
			return false
		}
	}
	return math.Abs(x) >= 1 && math.Abs(y) >= 1
}
