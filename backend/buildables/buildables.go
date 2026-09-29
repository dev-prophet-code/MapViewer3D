// Package buildables exportiert den Katalog der baubaren Teile und Platzierbaren
// (DT_BuildingData_*, DT_PlaceableData_*) samt vereinfachter Geometrie aus den
// Kollisionsformen (Boxen, konvexe Hüllen, Kapseln, Dreiecksnetze).
//
// Die Basis-Exporte der Console (/api/bases/<id>/export) nennen je Teil einen
// building_type, der dem Zeilennamen dieser Tabellen entspricht.
//
// Aufbau in <dir>:
//
//	index.json     {rows: {Zeile: Row}, meshes: [Mesh]}
//	mesh/<id>.bin  Netz im lokalen Raum des StaticMesh (cm), Format mesh.WriteDML
package buildables

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"mapviewer3d/assets"
	"mapviewer3d/mesh"
	"mapviewer3d/ue"
	"mapviewer3d/zen"
)

type Row struct {
	Mesh   int        `json:"mesh"`  // Index in Meshes, -1 = ohne Geometrie
	Table  string     `json:"table"` // Quelltabelle, z. B. DT_BuildingData_Harkonnen
	Group  string     `json:"group"` // Fraktion bzw. Kategorie
	Kind   string     `json:"kind"`  // building | placeable
	Offset [3]float64 `json:"offset,omitempty"`
	Rot    [3]float64 `json:"rot,omitempty"`   // Pitch, Yaw, Roll (Grad)
	Scale  [3]float64 `json:"scale,omitempty"` // 0 = unverändert
}

type Mesh struct {
	ID      int        `json:"id"`
	Path    string     `json:"path"`
	Source  string     `json:"source"` // trimesh | agg | bounds
	Tris    int        `json:"tris"`
	Lo      [3]float32 `json:"lo"`
	Hi      [3]float32 `json:"hi"`
	PhysMat string     `json:"physMat,omitempty"`
}

type Index struct {
	Rows   map[string]Row `json:"rows"`
	Meshes []Mesh         `json:"meshes"`
}

// Export liest alle Bauteiltabellen und schreibt Katalog und Netze nach dir.
func Export(db *assets.DB, dir string) (*Index, error) {
	if err := os.MkdirAll(filepath.Join(dir, "mesh"), 0o755); err != nil {
		return nil, err
	}
	idx := &Index{Rows: map[string]Row{}}
	meshIDs := map[string]int{}
	var tables []string
	for _, p := range db.Paths() {
		if strings.Contains(p, "/DT_BuildingData_") || strings.Contains(p, "/DT_PlaceableData_") {
			tables = append(tables, p)
		}
	}
	sort.Strings(tables)
	for _, t := range tables {
		pk, err := db.LoadPath(t)
		if err != nil || len(pk.Exports) == 0 {
			continue
		}
		r := pk.Reader(pk.Exports[0])
		if _, err := r.Properties(); err != nil {
			continue
		}
		rows, err := r.DataTableRows()
		if err != nil {
			fmt.Fprintf(os.Stderr, "%s: %v\n", t, err)
		}
		table := path.Base(t)
		kind, group := "building", strings.TrimPrefix(table, "DT_BuildingData_")
		if strings.Contains(table, "Placeable") {
			kind, group = "placeable", strings.TrimPrefix(table, "DT_PlaceableData_")
		}
		for _, row := range rows {
			out := Row{Mesh: -1, Table: table, Group: group, Kind: kind}
			if sm, ok := zen.Find(row.Props, "m_StaticMesh"); ok {
				if mp := pk.SoftPath(sm); mp != "" && mp != "None" {
					id, seen := meshIDs[mp]
					if !seen {
						id = -1
						if m, info, err := geometry(db, mp); err == nil && len(m.Idx) > 0 {
							id = len(idx.Meshes)
							info.ID = id
							if err := mesh.WriteDML(filepath.Join(dir, "mesh", fmt.Sprintf("%d.bin", id)), m); err != nil {
								return nil, err
							}
							idx.Meshes = append(idx.Meshes, info)
						}
						meshIDs[mp] = id
					}
					out.Mesh = id
				}
			}
			if p, ok := zen.Find(row.Props, "m_StaticMeshOffset"); ok {
				out.Offset = p.Vec()
			}
			if p, ok := zen.Find(row.Props, "m_StaticMeshLocalRotation"); ok {
				out.Rot = p.Vec()
			}
			if p, ok := zen.Find(row.Props, "m_StaticMeshScaleOverride"); ok {
				out.Scale = p.Vec()
			}
			if _, dup := idx.Rows[row.Name]; !dup || out.Mesh >= 0 {
				idx.Rows[row.Name] = out
			}
		}
		db.Forget(pk.ID)
	}
	js, err := json.Marshal(idx)
	if err != nil {
		return nil, err
	}
	return idx, os.WriteFile(filepath.Join(dir, "index.json"), js, 0o644)
}

// geometry liefert das beste verfügbare Netz eines StaticMesh.
func geometry(db *assets.DB, meshPath string) (mesh.Mesh, Mesh, error) {
	return Geometry(db, meshPath, true)
}

// Geometry liefert das beste verfügbare Netz eines StaticMesh: Dreiecksnetz der
// Kollision, sonst die vereinfachten Formen, mit allowBounds zuletzt die Hüllbox.
func Geometry(db *assets.DB, meshPath string, allowBounds bool) (mesh.Mesh, Mesh, error) {
	info := Mesh{Path: meshPath}
	pk, err := db.LoadPath(meshPath)
	if err != nil {
		return mesh.Mesh{}, info, err
	}
	defer db.Forget(pk.ID)
	var parts []mesh.Mesh
	var agg []mesh.Mesh
	for _, e := range pk.Exports {
		if e.Class != "BodySetup" {
			continue
		}
		r := pk.Reader(e)
		props, err := r.Properties()
		if err != nil {
			continue
		}
		parts = append(parts, mesh.FindTriMeshes(r.B[r.P:])...)
		if ag, ok := zen.Find(props, "AggGeom"); ok {
			agg = append(agg, aggGeom(pk, pk.Struct(ag))...)
		}
		if pm, ok := zen.Find(props, "PhysMaterial"); ok {
			if ref, err := db.Resolve(pk, pm.ObjectIndex()); err == nil {
				info.PhysMat = ref.Name
			}
		}
	}
	var m mesh.Mesh
	switch {
	case len(parts) > 0:
		m, info.Source = mesh.Merge(parts), "trimesh"
	case len(agg) > 0:
		m, info.Source = mesh.Merge(agg), "agg"
	default:
		lo, hi, ok := bounds(pk)
		if !ok || !allowBounds {
			return m, info, fmt.Errorf("keine Geometrie")
		}
		b := mesh.Box(hi[0]-lo[0], hi[1]-lo[1], hi[2]-lo[2])
		c := [3]float64{(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2}
		m = b.Transformed(func(p [3]float64) [3]float64 { return [3]float64{p[0] + c[0], p[1] + c[1], p[2] + c[2]} })
		info.Source = "bounds"
	}
	info.Tris = len(m.Idx) / 3
	info.Lo, info.Hi = m.Bounds()
	return m, info, nil
}

// aggGeom baut Netze aus den vereinfachten Kollisionsformen (FKAggregateGeom).
func aggGeom(pk *zen.Package, props []zen.Property) []mesh.Mesh {
	var out []mesh.Mesh
	num := func(ps []zen.Property, n string) float64 {
		if p, ok := zen.Find(ps, n); ok {
			return p.Float()
		}
		return 0
	}
	vec := func(ps []zen.Property, n string) [3]float64 {
		if p, ok := zen.Find(ps, n); ok {
			return p.Vec()
		}
		return [3]float64{}
	}
	place := func(m mesh.Mesh, t ue.Mat) mesh.Mesh { return m.Transformed(t.Apply) }
	one := [3]float64{1, 1, 1}
	for _, group := range props {
		_, elems, _ := pk.StructArray(group)
		for _, el := range elems {
			switch group.Name {
			case "BoxElems":
				t := ue.FromTRS(vec(el, "Center"), vec(el, "Rotation"), one)
				out = append(out, place(mesh.Box(num(el, "X"), num(el, "Y"), num(el, "Z")), t))
			case "SphereElems":
				t := ue.FromTRS(vec(el, "Center"), [3]float64{}, one)
				out = append(out, place(mesh.Capsule(num(el, "Radius"), 0), t))
			case "SphylElems", "TaperedCapsuleElems":
				t := ue.FromTRS(vec(el, "Center"), vec(el, "Rotation"), one)
				r := num(el, "Radius")
				if r == 0 {
					r = (num(el, "Radius0") + num(el, "Radius1")) / 2
				}
				out = append(out, place(mesh.Capsule(r, num(el, "Length")), t))
			case "ConvexElems":
				if m, ok := convex(pk, el); ok {
					out = append(out, m)
				}
			}
		}
	}
	return out
}

func convex(pk *zen.Package, el []zen.Property) (mesh.Mesh, bool) {
	vd, ok1 := zen.Find(el, "VertexData")
	id, ok2 := zen.Find(el, "IndexData")
	if !ok1 || !ok2 || len(id.Raw) < 4 {
		return mesh.Mesh{}, false
	}
	_, _, raw := pk.StructArray(vd)
	m := mesh.Mesh{}
	for _, v := range raw {
		p := zen.Property{Raw: v}.Vec()
		m.Pos = append(m.Pos, float32(p[0]), float32(p[1]), float32(p[2]))
	}
	n := int(binary.LittleEndian.Uint32(id.Raw))
	nv := uint32(len(raw))
	for k := 0; k < n && 4+4*k+4 <= len(id.Raw); k++ {
		i := binary.LittleEndian.Uint32(id.Raw[4+4*k:])
		if i >= nv {
			return mesh.Mesh{}, false
		}
		m.Idx = append(m.Idx, i)
	}
	m.Idx = m.Idx[:len(m.Idx)/3*3]
	if tr, ok := zen.Find(el, "Transform"); ok {
		t := transform(pk.Struct(tr))
		m = m.Transformed(t.Apply)
	}
	return m, len(m.Idx) > 0
}

// transform liest eine getaggte FTransform-Struktur.
func transform(props []zen.Property) ue.Mat {
	q := [4]float64{0, 0, 0, 1}
	loc := [3]float64{}
	scale := [3]float64{1, 1, 1}
	if p, ok := zen.Find(props, "Rotation"); ok && len(p.Raw) >= 32 {
		for i := range q {
			q[i] = math.Float64frombits(binary.LittleEndian.Uint64(p.Raw[8*i:]))
		}
	}
	if p, ok := zen.Find(props, "Translation"); ok {
		loc = p.Vec()
	}
	if p, ok := zen.Find(props, "Scale3D"); ok {
		scale = p.Vec()
	}
	return ue.FromQuatTRS(q, loc, scale)
}

// bounds liest ExtendedBounds (Origin ± BoxExtent) des StaticMesh.
func bounds(pk *zen.Package) (lo, hi [3]float64, ok bool) {
	for _, e := range pk.Exports {
		if e.Class != "StaticMesh" {
			continue
		}
		r := pk.Reader(e)
		props, _ := r.Properties()
		eb, found := zen.Find(props, "ExtendedBounds")
		if !found {
			continue
		}
		sp := pk.Struct(eb)
		o, _ := zen.Find(sp, "Origin")
		x, _ := zen.Find(sp, "BoxExtent")
		ov, xv := o.Vec(), x.Vec()
		if xv[0] <= 0 && xv[1] <= 0 && xv[2] <= 0 {
			continue
		}
		for i := 0; i < 3; i++ {
			lo[i], hi[i] = ov[i]-xv[i], ov[i]+xv[i]
		}
		return lo, hi, true
	}
	return lo, hi, false
}
