// Package landscape holt die Geländehöhen aus den gekochten
// LandscapeHeightfieldCollisionComponents eines Kartenpakets.
//
// Der Serverbuild enthält keine Render-Heightmaps, wohl aber die Kollision:
// je Komponente ein Chaos::FHeightField mit (Quads+1)² uint16-Werten, die über
// MinValue + Wert·HeightPerUnit auf lokale Landschaftseinheiten (1/128) abbilden.
package landscape

import (
	"encoding/binary"
	"fmt"
	"math"

	"mapviewer3d/zen"
)

type Transform struct {
	Loc   [3]float64
	Scale [3]float64
}

// Component ist ein dekodiertes Kollisionsfeld in Weltkoordinaten.
type Component struct {
	Package      string
	Name         string
	SectionBaseX int
	SectionBaseY int
	Quads        int     // CollisionSizeQuads
	Step         float64 // CollisionScale (Quads je Kollisionsquad)
	Rows, Cols   int
	Heights      []float64  // Welt-Z in cm, row-major (Zeile = Y)
	Origin       [2]float64 // Welt-XY der Ecke (0,0) in cm
	Spacing      [2]float64 // Welt-Abstand zwischen Stützpunkten in cm
}

// Extract liest alle Kollisionskomponenten eines Pakets.
func Extract(pkgName string, pk *zen.Package) ([]Component, error) {
	// Transform der Proxys (RootComponent) je Export-Index.
	props := make([][]zen.Property, len(pk.Exports))
	rest := make([][]byte, len(pk.Exports))
	for i, e := range pk.Exports {
		r := pk.Reader(e)
		if r.B == nil {
			continue
		}
		p, err := r.Properties()
		if err != nil {
			continue
		}
		props[i] = p
		rest[i] = r.B[r.P:]
	}
	transformOf := func(exportIdx int) Transform {
		t := Transform{Scale: [3]float64{1, 1, 1}}
		if exportIdx < 0 || exportIdx >= len(props) {
			return t
		}
		if p, ok := zen.Find(props[exportIdx], "RelativeLocation"); ok {
			t.Loc = p.Vec()
		}
		if p, ok := zen.Find(props[exportIdx], "RelativeScale3D"); ok {
			t.Scale = p.Vec()
		}
		return t
	}

	var out []Component
	for i, e := range pk.Exports {
		if e.Class != "LandscapeHeightfieldCollisionComponent" || props[i] == nil {
			continue
		}
		c := Component{Package: pkgName, Name: e.Name, Step: 1}
		if p, ok := zen.Find(props[i], "SectionBaseX"); ok {
			c.SectionBaseX = int(p.Int())
		}
		if p, ok := zen.Find(props[i], "SectionBaseY"); ok {
			c.SectionBaseY = int(p.Int())
		}
		if p, ok := zen.Find(props[i], "CollisionSizeQuads"); ok {
			c.Quads = int(p.Int())
		}
		if p, ok := zen.Find(props[i], "CollisionScale"); ok {
			c.Step = p.Float()
		}
		rel := transformOf(-1)
		rel.Scale = [3]float64{1, 1, 1}
		if p, ok := zen.Find(props[i], "RelativeLocation"); ok {
			rel.Loc = p.Vec()
		}
		// Elterntransform: AttachParent → Root des Proxys.
		parent := transformOf(-1)
		if p, ok := zen.Find(props[i], "AttachParent"); ok && p.ObjectIndex() > 0 {
			parent = transformOf(int(p.ObjectIndex()) - 1)
		}
		hf, err := decodeHeightfield(rest[i], c.Quads)
		if err != nil {
			return out, fmt.Errorf("%s/%s: %w", pkgName, e.Name, err)
		}
		c.Rows, c.Cols = hf.rows, hf.cols
		sx, sy, sz := parent.Scale[0], parent.Scale[1], parent.Scale[2]
		c.Origin = [2]float64{parent.Loc[0] + sx*rel.Loc[0], parent.Loc[1] + sy*rel.Loc[1]}
		c.Spacing = [2]float64{sx * c.Step, sy * c.Step}
		baseZ := parent.Loc[2] + sz*rel.Loc[2]
		c.Heights = make([]float64, len(hf.values))
		for k, v := range hf.values {
			local := hf.min + float64(v)*hf.perUnit // Landschaftseinheiten, int16-zentriert
			c.Heights[k] = baseZ + sz*local/128.0
		}
		out = append(out, c)
	}
	return out, nil
}

type heightfield struct {
	rows, cols int
	min        float64
	perUnit    float64
	values     []uint16
}

// decodeHeightfield sucht im nativen Rest der Komponente das Chaos-Heightfield:
// TArray<uint16> Heights, danach FVector3f Scale, double Min, Max,
// uint16 Rows, Cols, double Range, HeightPerUnit.
func decodeHeightfield(b []byte, quads int) (*heightfield, error) {
	le := binary.LittleEndian
	for _, n := range []int{quads + 1, quads/2 + 1, quads/4 + 1} {
		count := n * n
		for p := 0; p+4+2*count+48 <= len(b); p++ {
			if int(le.Uint32(b[p:])) != count {
				continue
			}
			t := p + 4 + 2*count
			mn := math.Float64frombits(le.Uint64(b[t+12:]))
			mx := math.Float64frombits(le.Uint64(b[t+20:]))
			rows := int(le.Uint16(b[t+28:]))
			cols := int(le.Uint16(b[t+30:]))
			rng := math.Float64frombits(le.Uint64(b[t+32:]))
			hpu := math.Float64frombits(le.Uint64(b[t+40:]))
			if rows*cols != count || math.Abs(mx-mn-rng) > 1e-3 || hpu < 0 || hpu > 1e6 {
				continue
			}
			hf := &heightfield{rows: rows, cols: cols, min: mn, perUnit: hpu, values: make([]uint16, count)}
			for k := range hf.values {
				hf.values[k] = le.Uint16(b[p+4+2*k:])
			}
			return hf, nil
		}
	}
	return nil, fmt.Errorf("kein Heightfield gefunden (%d Bytes)", len(b))
}
