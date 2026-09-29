// Package mapbuild setzt aus den Serverpaks die Höhenkarte einer Karte zusammen:
// Landschaft (Heightfields der Kartenlevel, optional wiederholte Kacheln) als
// Grundlage, darüber Block-Landschaften und Meshes als Oberkante gerastert.
package mapbuild

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"mapviewer3d/assets"
	"mapviewer3d/blocks"
	"mapviewer3d/landscape"
	"mapviewer3d/mapdata"
	"mapviewer3d/maps"
	"mapviewer3d/raster"
)

// MaxCells begrenzt die Rasterkante; große Karten bekommen einen gröberen Abstand.
const MaxCells = 8192

type Result struct {
	Meta   mapdata.Meta
	Height []uint16
	Mat    []uint8
}

// Build baut die Karte def.
func Build(db *assets.DB, def maps.Def) (*Result, error) {
	col := blocks.Collect(db, def.Dirs)
	comps := col.Landscape
	if def.Repeat != "" {
		rep, err := repeatTiles(db, def.Repeat, def.Bounds)
		if err != nil {
			return nil, err
		}
		comps = append(comps, rep...)
	}
	st := col.Stats
	log.Printf("%s: %d Level, %d Landschaftskomponenten, %d Terrain-Blöcke, %d Netze (%d ohne Geometrie), %d Instanzen",
		def.Name, st.Levels, len(comps), st.Blocks, st.Meshes, st.NoGeometry, st.Instances)

	// Ausdehnung aus Landschaft und platzierter Geometrie
	lo := [2]float64{math.Inf(1), math.Inf(1)}
	hi := [2]float64{math.Inf(-1), math.Inf(-1)}
	grow := func(x, y float64) {
		lo[0], lo[1] = math.Min(lo[0], x), math.Min(lo[1], y)
		hi[0], hi[1] = math.Max(hi[0], x), math.Max(hi[1], y)
	}
	base := 100.0
	for _, c := range comps {
		grow(c.Origin[0], c.Origin[1])
		grow(c.Origin[0]+float64(c.Cols-1)*c.Spacing[0], c.Origin[1]+float64(c.Rows-1)*c.Spacing[1])
		base = math.Min(base, c.Spacing[0])
	}
	// Ohne Landschaft bestimmt die Geometrie die Fläche; mit Landschaft bleibt
	// Kulisse außerhalb (Fernansichten, äußerer Schildwall) draußen.
	if len(comps) == 0 {
		for _, p := range col.Placed {
			l, h := p.Mesh.Bounds()
			for _, x := range []float32{l[0], h[0]} {
				for _, y := range []float32{l[1], h[1]} {
					w := p.M.Apply([3]float64{float64(x), float64(y), float64(l[2])})
					grow(w[0], w[1])
				}
			}
		}
	}
	if def.Bounds != nil {
		b := def.Bounds
		lo[0], hi[0] = math.Max(lo[0], b[0]), math.Min(hi[0], b[1])
		lo[1], hi[1] = math.Max(lo[1], b[2]), math.Min(hi[1], b[3])
	}
	if math.IsInf(lo[0], 0) || hi[0] <= lo[0] || hi[1] <= lo[1] {
		return nil, fmt.Errorf("%s: keine Geometrie gefunden", def.Name)
	}
	ext := math.Max(hi[0]-lo[0], hi[1]-lo[1])
	sp := base * math.Ceil(ext/base/(MaxCells-1))
	lo[0] = math.Floor(lo[0]/sp) * sp
	lo[1] = math.Floor(lo[1]/sp) * sp
	w := int(math.Ceil((hi[0]-lo[0])/sp)) + 1
	h := int(math.Ceil((hi[1]-lo[1])/sp)) + 1
	log.Printf("%s: Raster %d×%d à %.0f cm", def.Name, w, h, sp)

	r := &Result{Mat: make([]uint8, w*h)}
	r.Meta = mapdata.Meta{Name: def.ID, Source: def.Name, Title: def.Title, Group: def.Group, Live: def.Live,
		Width: w, Height: h, OriginX: lo[0], OriginY: lo[1], Spacing: sp, Comps: len(comps),
		Blocks: st.Blocks, Meshes: st.Meshes, Levels: st.Levels, Material: true}
	z := make([]float32, w*h)
	for i := range z {
		z[i] = float32(math.Inf(-1))
	}
	for _, c := range comps {
		for row := 0; row < c.Rows; row++ {
			for col := 0; col < c.Cols; col++ {
				x := int(math.Round((c.Origin[0] + float64(col)*c.Spacing[0] - lo[0]) / sp))
				y := int(math.Round((c.Origin[1] + float64(row)*c.Spacing[1] - lo[1]) / sp))
				if x < 0 || y < 0 || x >= w || y >= h {
					continue
				}
				v := float32(c.Heights[row*c.Cols+col])
				if i := y*w + x; r.Mat[i] == mapdata.MatNone || v > z[i] {
					z[i] = v
					r.Mat[i] = mapdata.MatLandscape
				}
			}
		}
	}
	r.overlay(z, col.Placed)

	minZ, maxZ := math.Inf(1), math.Inf(-1)
	for i, v := range z {
		if r.Mat[i] != mapdata.MatNone {
			minZ = math.Min(minZ, float64(v))
			maxZ = math.Max(maxZ, float64(v))
		}
	}
	if math.IsInf(minZ, 0) {
		return nil, fmt.Errorf("%s: Raster leer", def.Name)
	}
	if maxZ-minZ < 1 {
		maxZ = minZ + 1
	}
	r.Meta.MinZ, r.Meta.MaxZ = minZ, maxZ
	r.Height = make([]uint16, w*h)
	for i, v := range z {
		if r.Mat[i] != mapdata.MatNone {
			r.Height[i] = uint16(1 + math.Round((float64(v)-minZ)/(maxZ-minZ)*65534))
		}
	}
	return r, nil
}

// repeatTiles legt die Kachelvorlage (Pakete mit Präfix) lückenlos über bounds.
func repeatTiles(db *assets.DB, prefix string, bounds *[4]float64) ([]landscape.Component, error) {
	var tiles []landscape.Component
	var paths []string
	for _, p := range db.Paths() {
		if strings.HasPrefix(p, prefix) && !strings.Contains(p, "LOD") {
			paths = append(paths, p)
		}
	}
	sort.Strings(paths)
	for _, p := range paths {
		pk, err := db.LoadPath(p)
		if err != nil {
			continue
		}
		cs, _ := landscape.Extract(filepath.Base(p), pk)
		tiles = append(tiles, cs...)
		db.Forget(pk.ID)
	}
	if len(tiles) == 0 || bounds == nil {
		return nil, fmt.Errorf("keine Kacheln für %s", prefix)
	}
	lo := [2]float64{math.Inf(1), math.Inf(1)}
	hi := [2]float64{math.Inf(-1), math.Inf(-1)}
	for _, c := range tiles {
		lo[0], lo[1] = math.Min(lo[0], c.Origin[0]), math.Min(lo[1], c.Origin[1])
		hi[0] = math.Max(hi[0], c.Origin[0]+float64(c.Cols-1)*c.Spacing[0])
		hi[1] = math.Max(hi[1], c.Origin[1]+float64(c.Rows-1)*c.Spacing[1])
	}
	px, py := hi[0]-lo[0], hi[1]-lo[1]
	var out []landscape.Component
	for oy := math.Floor((bounds[2]-lo[1])/py) * py; lo[1]+oy < bounds[3]; oy += py {
		for ox := math.Floor((bounds[0]-lo[0])/px) * px; lo[0]+ox < bounds[1]; ox += px {
			for _, c := range tiles {
				c.Origin = [2]float64{c.Origin[0] + ox, c.Origin[1] + oy}
				out = append(out, c)
			}
		}
	}
	log.Printf("Kachelvorlage %s: %d Komponenten, %d Wiederholungen", filepath.Base(prefix), len(tiles), len(out)/len(tiles))
	return out, nil
}

// overlay: Block-Landschaft ersetzt die Grundlandschaft, Meshes liegen obenauf.
func (r *Result) overlay(z []float32, placed []blocks.Placed) {
	m := r.Meta
	var land, rock []raster.Item
	for _, p := range placed {
		it := raster.Item{Mesh: p.Mesh, M: p.M}
		if p.Kind == blocks.Landscape {
			land = append(land, it)
		} else {
			rock = append(rock, it)
		}
	}
	gl := raster.New(m.Width, m.Height, m.OriginX, m.OriginY, m.Spacing)
	gl.Draw(land)
	gr := raster.New(m.Width, m.Height, m.OriginX, m.OriginY, m.Spacing)
	gr.Draw(rock)
	var nl, nr int
	for i := range z {
		if v := gl.At(i); !math.IsInf(float64(v), -1) {
			z[i] = v
			r.Mat[i] = mapdata.MatBlockLandscape
			nl++
		}
		if v := gr.At(i); !math.IsInf(float64(v), -1) && (r.Mat[i] == mapdata.MatNone || v > z[i]+5) {
			z[i] = v
			r.Mat[i] = mapdata.MatRock
			nr++
		}
	}
	log.Printf("gerastert: %.1f %% Block-Landschaft, %.1f %% Fels/Bauwerk",
		100*float64(nl)/float64(len(z)), 100*float64(nr)/float64(len(z)))
}

// Write speichert Höhen, Material, Meta und Vorschaubild nach dir.
func (r *Result) Write(dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	raw := make([]byte, 2*len(r.Height))
	for i, v := range r.Height {
		binary.LittleEndian.PutUint16(raw[2*i:], v)
	}
	if err := os.WriteFile(filepath.Join(dir, mapdata.FileHeight), raw, 0o644); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, mapdata.FileMaterial), r.Mat, 0o644); err != nil {
		return err
	}
	mj, _ := json.MarshalIndent(r.Meta, "", "  ")
	return os.WriteFile(filepath.Join(dir, mapdata.FileMeta), mj, 0o644)
}
