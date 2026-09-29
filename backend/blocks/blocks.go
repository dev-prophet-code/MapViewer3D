// Package blocks sammelt die Geometrie einer Karte aus ihren Levels:
//
//   - Landschaftskomponenten (Heightfields) der Level im Kartenordner,
//   - StaticMesh- und InstancedStaticMesh-Komponenten dieser Level,
//   - über Terrain-Blöcke (BP_TerrainBlockActor) platzierte Inhalte: die
//     Level <Block>_ArtCollision und <Block>_Art samt deren Landschaft.
//
// Für Meshes wird die Kollisionsgeometrie verwendet (Dreiecksnetz oder
// vereinfachte Formen); der Serverbuild enthält keine Render-Geometrie.
package blocks

import (
	"encoding/binary"
	"math"
	"path"
	"sort"
	"strings"

	"mapviewer3d/assets"
	"mapviewer3d/buildables"
	"mapviewer3d/landscape"
	"mapviewer3d/mesh"
	"mapviewer3d/ue"
	"mapviewer3d/zen"
)

type Kind int

const (
	Rock      Kind = iota // Kollisionsnetz eines StaticMesh
	Landscape             // Block-eigene Landschaft
)

// Placed ist ein Netz (lokal, cm) mit Welttransform (Unreal, cm).
type Placed struct {
	Mesh *mesh.Mesh
	M    ue.Mat
	Kind Kind
	Name string
}

type Stats struct {
	Levels, Blocks, Meshes, NoGeometry, Landscapes, Instances int
}

type Result struct {
	Placed    []Placed
	Landscape []landscape.Component // Heightfields der Kartenlevel (Weltkoordinaten)
	Stats     Stats
}

// Level, die nichts zur Geometrie beitragen oder nur Fernansichten enthalten.
var skipLevel = []string{"/LOD/", "_LOD", "HLOD", "/VistaTiles/", "Vista", "Cinematic", "EditorOnly",
	"_Audio", "_Fog", "_Lighting", "_VFX", "_Hazards", "OutofBound", "AreaDefinedSplines", "SecurityZones"}

// Unsichtbare Technik-Meshes (Kollisionsblocker, Hilfsflächen) gehören nicht zur Karte.
var skipMesh = []string{"/TechArt/", "SimplePlane", "Blocker", "Blocking", "Invisible", "/Debug/", "/Developers/"}

func technical(p string) bool {
	for _, s := range skipMesh {
		if strings.Contains(p, s) {
			return true
		}
	}
	return false
}

func skipped(p string) bool {
	for _, s := range skipLevel {
		if strings.Contains(p, s) {
			return true
		}
	}
	return false
}

type collector struct {
	db     *assets.DB
	byBase map[string]string
	cache  map[string]*mesh.Mesh
	props  map[*zen.Package][][]zen.Property
	res    Result
}

// Collect liest alle Level unter den Ordnerpräfixen dirs.
func Collect(db *assets.DB, dirs []string) Result {
	c := &collector{db: db, byBase: map[string]string{}, cache: map[string]*mesh.Mesh{},
		props: map[*zen.Package][][]zen.Property{}}
	var levels []string
	for _, p := range db.Paths() {
		c.byBase[path.Base(p)] = p
		for _, d := range dirs {
			if strings.HasPrefix(p, d) && !skipped(p) {
				levels = append(levels, p)
				break
			}
		}
	}
	sort.Strings(levels)
	for _, lp := range levels {
		pk, err := db.LoadPath(lp)
		if err != nil || !isLevel(pk) {
			continue
		}
		c.res.Stats.Levels++
		if comps, _ := landscape.Extract(path.Base(lp), pk); len(comps) > 0 {
			c.res.Landscape = append(c.res.Landscape, comps...)
		}
		for i, e := range pk.Exports {
			if strings.Contains(db.ClassName(pk, e), "TerrainBlockActor") {
				c.terrainBlock(pk, i)
			}
		}
		c.components(pk, ue.Identity())
		c.forget(pk)
	}
	c.res.Stats.Instances = len(c.res.Placed)
	return c.res
}

func isLevel(pk *zen.Package) bool {
	for _, e := range pk.Exports {
		if e.Class == "World" || e.Class == "Level" {
			return true
		}
	}
	return false
}

func (c *collector) forget(pk *zen.Package) {
	delete(c.props, pk)
	c.db.Forget(pk.ID)
}

func (c *collector) terrainBlock(pk *zen.Package, i int) {
	ps := c.propsOf(pk, i)
	asset, ok := zen.Find(ps, "m_TerrainBlockAsset")
	if !ok {
		return
	}
	ref, err := c.db.Resolve(pk, asset.ObjectIndex())
	if err != nil || ref.Name == "" {
		return
	}
	world := ue.Identity()
	if rc, ok := zen.Find(ps, "RootComponent"); ok && rc.ObjectIndex() > 0 {
		world = c.worldOf(pk, int(rc.ObjectIndex())-1)
	}
	c.placeBlock(ref.Name, world)
}

// placeBlock setzt den Terrain-Block asset (Levels <asset>_ArtCollision und <asset>_Art)
// an den Welttransform world.
func (c *collector) placeBlock(asset string, world ue.Mat) {
	c.res.Stats.Blocks++
	for _, suffix := range []string{"_ArtCollision", "_Art"} {
		lp, ok := c.byBase[asset+suffix]
		if !ok {
			continue
		}
		bp, err := c.db.LoadPath(lp)
		if err != nil {
			continue
		}
		c.components(bp, world)
		if suffix == "_Art" {
			if m := c.blockLandscape(lp, bp); m != nil {
				c.res.Placed = append(c.res.Placed, Placed{Mesh: m, M: world, Kind: Landscape, Name: lp})
			}
		}
	}
}

// Ref ist ein Terrain-Block, der ohne Level-Actor platziert wird (Cluster eines Layouts).
type Ref struct {
	Asset string // Name des Blocks, z. B. CB_Arrakis_Generic_SD_05
	M     ue.Mat
}

// CollectRefs setzt die Blöcke refs so zusammen, als stünden sie als Actors in einem Level.
func CollectRefs(db *assets.DB, refs []Ref) Result {
	c := &collector{db: db, byBase: map[string]string{}, cache: map[string]*mesh.Mesh{},
		props: map[*zen.Package][][]zen.Property{}}
	for _, p := range db.Paths() {
		c.byBase[path.Base(p)] = p
	}
	for _, r := range refs {
		c.placeBlock(r.Asset, r.M)
	}
	c.res.Stats.Instances = len(c.res.Placed)
	return c.res
}

// components platziert alle (Instanced)StaticMeshComponents eines Levels.
func (c *collector) components(pk *zen.Package, world ue.Mat) {
	for i, e := range pk.Exports {
		cls := c.db.ClassName(pk, e)
		ism := strings.Contains(cls, "InstancedStaticMeshComponent")
		if cls != "StaticMeshComponent" && !ism {
			continue
		}
		sm, ok := zen.Find(c.propsOf(pk, i), "StaticMesh")
		if !ok {
			continue
		}
		ref, err := c.db.Resolve(pk, sm.ObjectIndex())
		if err != nil || !ref.Valid() || technical(ref.Pkg.Path) {
			continue
		}
		m := c.staticMesh(ref)
		if m == nil {
			continue
		}
		comp := world.Mul(c.worldOf(pk, i))
		if !ism {
			c.res.Placed = append(c.res.Placed, Placed{Mesh: m, M: comp, Kind: Rock, Name: ref.Pkg.Path})
			continue
		}
		for _, inst := range instances(pk, e) {
			c.res.Placed = append(c.res.Placed, Placed{Mesh: m, M: comp.Mul(inst), Kind: Rock, Name: ref.Pkg.Path})
		}
	}
}

// instances liest PerInstanceSMData (Bulk-Array aus FMatrix, double, Zeilenvektoren).
func instances(pk *zen.Package, e zen.Export) []ue.Mat {
	r := pk.Reader(e)
	if r.B == nil {
		return nil
	}
	if _, err := r.Properties(); err != nil {
		return nil
	}
	rest := r.B[r.P:]
	le := binary.LittleEndian
	for o := 0; o+8 <= len(rest) && o <= 64; o += 4 {
		es, n := int(le.Uint32(rest[o:])), int(le.Uint32(rest[o+4:]))
		if es != 128 || n <= 0 || o+8+es*n > len(rest) {
			continue
		}
		out := make([]ue.Mat, 0, n)
		for k := 0; k < n; k++ {
			b := rest[o+8+k*es:]
			var row [4][4]float64
			for i := 0; i < 16; i++ {
				row[i/4][i%4] = math.Float64frombits(le.Uint64(b[8*i:]))
			}
			if row[3][3] != 1 {
				return nil
			}
			var m ue.Mat // transponiert: Spaltenvektoren
			for i := 0; i < 4; i++ {
				for j := 0; j < 4; j++ {
					m[i][j] = row[j][i]
				}
			}
			out = append(out, m)
		}
		return out
	}
	return nil
}

func (c *collector) propsOf(pk *zen.Package, i int) []zen.Property {
	all := c.props[pk]
	if all == nil {
		all = make([][]zen.Property, len(pk.Exports))
		c.props[pk] = all
	}
	if all[i] == nil {
		r := pk.Reader(pk.Exports[i])
		if r.B != nil {
			all[i], _ = r.Properties()
		}
		if all[i] == nil {
			all[i] = []zen.Property{}
		}
	}
	return all[i]
}

// worldOf verkettet die Relativtransforms entlang AttachParent innerhalb eines Pakets.
func (c *collector) worldOf(pk *zen.Package, i int) ue.Mat {
	m := ue.Identity()
	for depth := 0; depth < 32 && i >= 0 && i < len(pk.Exports); depth++ {
		ps := c.propsOf(pk, i)
		m = ue.Relative(ps).Mul(m)
		ap, ok := zen.Find(ps, "AttachParent")
		if !ok || ap.ObjectIndex() <= 0 {
			break
		}
		i = int(ap.ObjectIndex()) - 1
	}
	return m
}

// staticMesh liefert die Kollisionsgeometrie eines StaticMesh (zwischengespeichert).
func (c *collector) staticMesh(ref assets.Ref) *mesh.Mesh {
	key := ref.Pkg.Path
	if m, ok := c.cache[key]; ok {
		return m
	}
	var out *mesh.Mesh
	if m, _, err := buildables.Geometry(c.db, key, false); err == nil && len(m.Idx) > 0 {
		out = &m
		c.res.Stats.Meshes++
	} else {
		c.res.Stats.NoGeometry++
	}
	c.cache[key] = out
	return out
}

// blockLandscape trianguliert die Landschaftskomponenten eines Block-Levels (lokal).
func (c *collector) blockLandscape(key string, pk *zen.Package) *mesh.Mesh {
	key = "hf:" + key
	if m, ok := c.cache[key]; ok {
		return m
	}
	comps, _ := landscape.Extract(pk.Path, pk)
	var parts []mesh.Mesh
	for _, lc := range comps {
		m := mesh.Mesh{}
		for r := 0; r < lc.Rows; r++ {
			for k := 0; k < lc.Cols; k++ {
				m.Pos = append(m.Pos,
					float32(lc.Origin[0]+float64(k)*lc.Spacing[0]),
					float32(lc.Origin[1]+float64(r)*lc.Spacing[1]),
					float32(lc.Heights[r*lc.Cols+k]))
			}
		}
		for r := 0; r < lc.Rows-1; r++ {
			for k := 0; k < lc.Cols-1; k++ {
				a := uint32(r*lc.Cols + k)
				n := uint32(lc.Cols)
				m.Idx = append(m.Idx, a, a+1, a+n, a+1, a+n+1, a+n)
			}
		}
		parts = append(parts, m)
	}
	var out *mesh.Mesh
	if len(parts) > 0 {
		m := mesh.Merge(parts)
		out = &m
		c.res.Stats.Landscapes++
	}
	c.cache[key] = out
	return out
}
