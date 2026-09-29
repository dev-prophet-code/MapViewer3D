// Package layout liest die wöchentlichen Layouts der Deep Desert (Coriolis).
//
// Der Server wählt je Coriolis-Zyklus ein Layout (DA_DeepDesert_1_Layout_NN,
// NN = coriolisLayout der Console). Es enthält ein 24×24-Raster von Kacheln zu
// je 1016 m (PresetDimension der TiledLandscapeManager-Daten) und überschreibt
// darin einzelne Kacheln der Grundlandschaft; leere Zellen bleiben Dünen.
// Die Kacheln stehen in zwei Ebenen zu je 576 Einträgen (BiomeData und
// DeepDesertData, dieselben Zellen); die zweite deckt die oberen Reihen ab.
package layout

import (
	"encoding/binary"
	"fmt"
	"math"
	"path"
	"regexp"
	"strings"

	"mapviewer3d/assets"
	"mapviewer3d/landscape"
	"mapviewer3d/zen"
)

const (
	GridSize = 24       // Zellen je Kante
	TileSize = 101600.0 // cm je Zelle (PresetDimension)
)

// Origin ist der Ursprung des Rasters in Weltkoordinaten (cm): Ecke der Zelle (0,0).
//
// Aus den Daten abgeleitet: Das Raster ist auf die Kartenmitte zentriert (24 Zellen,
// 94 200 cm Rand je Seite), und die generischen Actors der Layouts liegen auf einem
// Raster von TileSize/16 (63,5 m), dessen Phase den Ursprung bis auf etwa 16 m festlegt.
var Origin = [2]float64{-1273375, -1272875}

// Tile ist eine überschriebene Zelle.
type Tile struct {
	GX, GY int
	Preset string     // Paketpfad der Landschaftskachel
	Bounds [6]float64 // FBox (min xyz, max xyz) der Kachel im Vorlagenraum, cm
}

// Cluster ist ein Baustein des Layouts (WLC_*): Kacheln und Content-Blöcke, verankert
// an einer Zelle des Rasters.
type Cluster struct {
	AX, AY    int    // ClusterAnchor: Zelle der Ecke des 4×4-Bereichs
	Asset     string // Paketpfad des WorldLayoutClusterDataAsset
	Variation string // ClusterVariation, z. B. Default oder Ecolab_012
}

// Layout ist der ausgelesene Kachelplan eines Layouts.
type Layout struct {
	N        int
	Tiles    []Tile
	Clusters []Cluster
}

var assetName = regexp.MustCompile(`/DeepDesert_1/Layouts/DA_DeepDesert_1_Layout_(\d+)$`)

// Available listet die Layout-Nummern, die in den Paks liegen.
func Available(db *assets.DB) []int {
	var out []int
	for _, p := range db.Paths() {
		if m := assetName.FindStringSubmatch(p); m != nil {
			var n int
			fmt.Sscan(m[1], &n)
			out = append(out, n)
		}
	}
	return out
}

// Load liest Layout n.
func Load(db *assets.DB, n int) (*Layout, error) {
	want := fmt.Sprintf("/DeepDesert_1/Layouts/DA_DeepDesert_1_Layout_%02d", n)
	var name string
	for _, p := range db.Paths() {
		if strings.HasSuffix(p, want) {
			name = p
			break
		}
	}
	if name == "" {
		return nil, fmt.Errorf("Layout %d nicht in den Paks", n)
	}
	pk, err := db.LoadPath(name)
	if err != nil {
		return nil, err
	}
	defer db.Forget(pk.ID)
	if len(pk.Exports) == 0 {
		return nil, fmt.Errorf("Layout %d: leer", n)
	}
	props, err := pk.Reader(pk.Exports[0]).Properties()
	if err != nil {
		return nil, fmt.Errorf("Layout %d: %w", n, err)
	}
	ov, ok := zen.Find(props, "m_TiledLandscapeBiomeDataOverride")
	if !ok {
		return nil, fmt.Errorf("Layout %d: kein m_TiledLandscapeBiomeDataOverride", n)
	}
	l := &Layout{N: n}
	if cp, ok := zen.Find(props, "m_Clusters"); ok {
		l.Clusters = readClusters(db, pk, cp)
	}
	for _, q := range pk.Struct(ov) {
		if q.Name != "Tiles" {
			continue
		}
		_, tagged, _ := pk.StructArray(q)
		for i, t := range tagged {
			tile := Tile{GX: i % GridSize, GY: (i % (GridSize * GridSize)) / GridSize}
			for _, r := range t {
				switch r.Name {
				case "Preset":
					tile.Preset = pk.SoftPath(r)
				case "PresetBounds":
					if len(r.Raw) >= 48 {
						for k := range tile.Bounds {
							tile.Bounds[k] = math.Float64frombits(binary.LittleEndian.Uint64(r.Raw[8*k:]))
						}
					}
				}
			}
			if tile.Preset == "" || tile.Preset == "None" {
				continue
			}
			l.Tiles = append(l.Tiles, tile)
		}
	}
	if len(l.Tiles) == 0 {
		return nil, fmt.Errorf("Layout %d: keine Kacheln gefunden", n)
	}
	return l, nil
}

// Presets liefert die Landschaftskomponenten je Vorlage (Vorlagenraum).
// Vorlagen, die sich nicht lesen lassen, fehlen in der Antwort.
func (l *Layout) Presets(db *assets.DB) map[string][]landscape.Component {
	out := map[string][]landscape.Component{}
	for _, t := range l.Tiles {
		if _, done := out[t.Preset]; done {
			continue
		}
		out[t.Preset] = nil
		pk, err := db.LoadPath(t.Preset)
		if err != nil {
			continue
		}
		cs, _ := landscape.Extract(path.Base(t.Preset), pk)
		db.Forget(pk.ID)
		if len(cs) > 0 {
			out[t.Preset] = cs
		}
	}
	return out
}

// Shift ist die Verschiebung, die Kachel t vom Vorlagenraum an ihre Zelle bringt.
func (t Tile) Shift(origin [2]float64) [2]float64 {
	return [2]float64{
		origin[0] + float64(t.GX)*TileSize - t.Bounds[0],
		origin[1] + float64(t.GY)*TileSize - t.Bounds[1],
	}
}

// Components setzt alle Kacheln in Weltkoordinaten.
func (l *Layout) Components(db *assets.DB, origin [2]float64) []landscape.Component {
	presets := l.Presets(db)
	var out []landscape.Component
	for _, t := range l.Tiles {
		sh := t.Shift(origin)
		for _, c := range presets[t.Preset] {
			c.Origin = [2]float64{c.Origin[0] + sh[0], c.Origin[1] + sh[1]}
			out = append(out, c)
		}
	}
	return out
}

// readClusters liest m_Clusters (Map uint32 → Struct): Anker, Datenasset und Variante.
func readClusters(db *assets.DB, pk *zen.Package, p zen.Property) []Cluster {
	var out []Cluster
	if len(p.Raw) < 8 {
		return nil
	}
	r := pk.Sub(p.Raw)
	r.I32() // zu entfernende Schlüssel
	n := int(r.I32())
	for i := 0; i < n && i < 100000 && r.P+4 <= len(r.B); i++ {
		r.U32() // Schlüssel (Hash)
		ps, err := r.Properties()
		if err != nil {
			break
		}
		var c Cluster
		for _, q := range ps {
			switch q.Name {
			case "ClusterAnchor":
				if len(q.Raw) >= 8 {
					c.AX = int(int32(binary.LittleEndian.Uint32(q.Raw)))
					c.AY = int(int32(binary.LittleEndian.Uint32(q.Raw[4:])))
				}
			case "ClusterDataAsset":
				if ref, err := db.Resolve(pk, q.ObjectIndex()); err == nil && ref.Pkg != nil {
					c.Asset = ref.Pkg.Path
				}
			case "ClusterVariation":
				if len(q.Raw) >= 8 {
					c.Variation = pk.Names[binary.LittleEndian.Uint32(q.Raw)&0x3fffffff]
				}
			}
		}
		if c.Asset != "" {
			out = append(out, c)
		}
	}
	return out
}
