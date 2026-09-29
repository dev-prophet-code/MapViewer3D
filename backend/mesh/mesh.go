// Package mesh holt Dreiecksnetze aus gekochten Chaos-Kollisionsdaten
// (BodySetup eines StaticMesh) und vereinfacht sie per Vertex-Clustering.
package mesh

import (
	"encoding/binary"
	"math"
)

// Mesh in lokalen Unreal-Koordinaten (cm).
type Mesh struct {
	Pos []float32 // x,y,z
	Idx []uint32
}

// FindTriMeshes sucht Chaos-Trimeshes: uint32 N, N×FVector3f, uint32 bLargeIdx,
// uint32 M, M×3 Indizes (uint16 oder int32).
func FindTriMeshes(b []byte) []Mesh {
	le := binary.LittleEndian
	var out []Mesh
	for p := 0; p+8 < len(b); p++ {
		n := int(le.Uint32(b[p:]))
		if n < 3 || n > 5_000_000 {
			continue
		}
		vEnd := p + 4 + 12*n
		if vEnd+8 > len(b) {
			continue
		}
		large := le.Uint32(b[vEnd:])
		if large > 1 {
			continue
		}
		m := int(le.Uint32(b[vEnd+4:]))
		isz := 2
		if large == 1 {
			isz = 4
		}
		iEnd := vEnd + 8 + 3*isz*m
		if m < 1 || m > 10_000_000 || iEnd > len(b) {
			continue
		}
		if !plausibleFloats(b[p+4:vEnd], n) {
			continue
		}
		idx := make([]uint32, 3*m)
		ok := true
		for k := range idx {
			var v uint32
			if isz == 2 {
				v = uint32(le.Uint16(b[vEnd+8+2*k:]))
			} else {
				v = le.Uint32(b[vEnd+8+4*k:])
			}
			if int(v) >= n {
				ok = false
				break
			}
			idx[k] = v
		}
		if !ok {
			continue
		}
		pos := make([]float32, 3*n)
		for k := range pos {
			pos[k] = math.Float32frombits(le.Uint32(b[p+4+4*k:]))
		}
		out = append(out, Mesh{Pos: pos, Idx: idx})
		p = iEnd - 1
	}
	return out
}

func plausibleFloats(b []byte, n int) bool {
	le := binary.LittleEndian
	check := min(n*3, 300)
	nonzero := 0
	for k := 0; k < check; k++ {
		f := math.Float32frombits(le.Uint32(b[4*k:]))
		if math.IsNaN(float64(f)) || math.IsInf(float64(f), 0) || math.Abs(float64(f)) > 1e7 {
			return false
		}
		if f != 0 && math.Abs(float64(f)) < 1e-6 {
			return false
		}
		if f != 0 {
			nonzero++
		}
	}
	return nonzero > check/3
}

// Simplify vereinfacht per Vertex-Clustering mit Zellgröße cell (cm).
func Simplify(m Mesh, cell float32) Mesh {
	if cell <= 0 {
		return m
	}
	type key [3]int32
	ids := map[key]uint32{}
	var sums [][4]float64
	remap := make([]uint32, len(m.Pos)/3)
	for v := range remap {
		x, y, z := m.Pos[3*v], m.Pos[3*v+1], m.Pos[3*v+2]
		k := key{int32(math.Floor(float64(x / cell))), int32(math.Floor(float64(y / cell))), int32(math.Floor(float64(z / cell)))}
		id, ok := ids[k]
		if !ok {
			id = uint32(len(sums))
			ids[k] = id
			sums = append(sums, [4]float64{})
		}
		s := &sums[id]
		s[0] += float64(x)
		s[1] += float64(y)
		s[2] += float64(z)
		s[3]++
		remap[v] = id
	}
	out := Mesh{Pos: make([]float32, 3*len(sums))}
	for i, s := range sums {
		out.Pos[3*i] = float32(s[0] / s[3])
		out.Pos[3*i+1] = float32(s[1] / s[3])
		out.Pos[3*i+2] = float32(s[2] / s[3])
	}
	seen := map[[3]uint32]bool{}
	for t := 0; t+2 < len(m.Idx); t += 3 {
		a, b, c := remap[m.Idx[t]], remap[m.Idx[t+1]], remap[m.Idx[t+2]]
		if a == b || b == c || a == c {
			continue
		}
		k := [3]uint32{a, b, c}
		// gleiche Dreiecke unabhängig von der Startecke nur einmal
		for k[0] > k[1] || k[0] > k[2] {
			k = [3]uint32{k[1], k[2], k[0]}
		}
		if seen[k] {
			continue
		}
		seen[k] = true
		out.Idx = append(out.Idx, a, b, c)
	}
	return out
}

// Merge hängt mehrere Netze aneinander.
func Merge(ms []Mesh) Mesh {
	var out Mesh
	for _, m := range ms {
		base := uint32(len(out.Pos) / 3)
		out.Pos = append(out.Pos, m.Pos...)
		for _, i := range m.Idx {
			out.Idx = append(out.Idx, base+i)
		}
	}
	return out
}

// Bounds liefert die achsenparallele Hülle.
func (m Mesh) Bounds() (lo, hi [3]float32) {
	for k := 0; k < 3; k++ {
		lo[k], hi[k] = math.MaxFloat32, -math.MaxFloat32
	}
	for v := 0; v+2 < len(m.Pos); v += 3 {
		for k := 0; k < 3; k++ {
			lo[k] = min(lo[k], m.Pos[v+k])
			hi[k] = max(hi[k], m.Pos[v+k])
		}
	}
	return lo, hi
}

// Translated liefert eine um d verschobene Kopie.
func (m Mesh) Translated(d [3]float32) Mesh {
	out := Mesh{Pos: make([]float32, len(m.Pos)), Idx: m.Idx}
	for v := 0; v+2 < len(m.Pos); v += 3 {
		for k := 0; k < 3; k++ {
			out.Pos[v+k] = m.Pos[v+k] + d[k]
		}
	}
	return out
}

// Transformed wendet f auf alle Punkte an (Kopie).
func (m Mesh) Transformed(f func([3]float64) [3]float64) Mesh {
	out := Mesh{Pos: make([]float32, len(m.Pos)), Idx: m.Idx}
	for v := 0; v+2 < len(m.Pos); v += 3 {
		p := f([3]float64{float64(m.Pos[v]), float64(m.Pos[v+1]), float64(m.Pos[v+2])})
		out.Pos[v], out.Pos[v+1], out.Pos[v+2] = float32(p[0]), float32(p[1]), float32(p[2])
	}
	return out
}

// Box ist ein Quader mit Kantenlängen sx, sy, sz um den Ursprung.
func Box(sx, sy, sz float64) Mesh {
	hx, hy, hz := float32(sx/2), float32(sy/2), float32(sz/2)
	m := Mesh{}
	for i := 0; i < 8; i++ {
		x, y, z := -hx, -hy, -hz
		if i&1 != 0 {
			x = hx
		}
		if i&2 != 0 {
			y = hy
		}
		if i&4 != 0 {
			z = hz
		}
		m.Pos = append(m.Pos, x, y, z)
	}
	m.Idx = []uint32{0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6, 0, 1, 4, 1, 5, 4, 2, 6, 3, 3, 6, 7, 0, 4, 2, 2, 4, 6, 1, 3, 5, 3, 7, 5}
	return m
}

// Capsule entlang Z: Zylinderlänge length, Radius r (length 0 = Kugel).
func Capsule(r, length float64) Mesh {
	const seg, rings = 12, 6
	m := Mesh{}
	half := length / 2
	// Ringe von oben nach unten: obere Halbkugel, untere Halbkugel
	var rows [][2]float64 // (Radius, z)
	for i := 0; i <= rings; i++ {
		a := math.Pi / 2 * float64(i) / rings
		rows = append(rows, [2]float64{r * math.Sin(a), half + r*math.Cos(a)})
	}
	for i := 0; i <= rings; i++ {
		a := math.Pi / 2 * float64(i) / rings
		rows = append(rows, [2]float64{r * math.Cos(a), -half - r*math.Sin(a)})
	}
	for _, row := range rows {
		for s := 0; s < seg; s++ {
			a := 2 * math.Pi * float64(s) / seg
			m.Pos = append(m.Pos, float32(row[0]*math.Cos(a)), float32(row[0]*math.Sin(a)), float32(row[1]))
		}
	}
	for i := 0; i+1 < len(rows); i++ {
		for s := 0; s < seg; s++ {
			a := uint32(i*seg + s)
			b := uint32(i*seg + (s+1)%seg)
			c, d := a+seg, b+seg
			m.Idx = append(m.Idx, a, c, b, b, c, d)
		}
	}
	return m
}
