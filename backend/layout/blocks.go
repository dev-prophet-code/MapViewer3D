package layout

import (
	"encoding/binary"
	"math"

	"mapviewer3d/assets"
	"mapviewer3d/zen"
)

// ClusterSpace ist der Ursprung des Autorenraums der Cluster (cm): Die Blöcke eines
// Clusters stehen dort um (-10160 m, -10160 m); die Ecke zwischen den Kacheln (2,2) und
// (1,1) des 4×4-Bereichs entspricht diesem Punkt (siehe TilePositionInClusterSpace).
var ClusterSpace = [2]float64{-1016000, -1016000}

// Block ist ein Content-Block (Felsen, Ecolab, Wrack …) in Weltkoordinaten.
type Block struct {
	Asset string     // Name des Terrain-Blocks, z. B. CB_Arrakis_Generic_SD_05
	Loc   [3]float64 // cm
	Rot   [3]float64 // Pitch, Yaw, Roll in Grad
}

// Blocks liefert die Content-Blöcke aller Cluster des Layouts in Weltkoordinaten.
func (l *Layout) Blocks(db *assets.DB, origin [2]float64) []Block {
	type entry struct {
		asset    string
		loc, rot [3]float64
	}
	cache := map[string]map[string][]entry{} // Cluster-Asset → Variante → Blöcke
	load := func(path string) map[string][]entry {
		if v, ok := cache[path]; ok {
			return v
		}
		vars := map[string][]entry{}
		cache[path] = vars
		pk, err := db.LoadPath(path)
		if err != nil || len(pk.Exports) == 0 {
			return vars
		}
		defer db.Forget(pk.ID)
		props, err := pk.Reader(pk.Exports[0]).Properties()
		if err != nil {
			return vars
		}
		vp, ok := zen.Find(props, "m_Variations")
		if !ok || len(vp.Raw) < 8 {
			return vars
		}
		r := pk.Sub(vp.Raw)
		r.I32()
		n := int(r.I32())
		for i := 0; i < n && i < 10000 && r.P+8 <= len(r.B); i++ {
			name := r.Name()
			vps, err := r.Properties()
			if err != nil {
				break
			}
			tb, ok := zen.Find(vps, "TerrainBlocks")
			if !ok {
				continue
			}
			_, tagged, _ := pk.StructArray(tb)
			for _, t := range tagged {
				var e entry
				enabled := true
				for _, q := range t {
					switch q.Name {
					case "bIsEnabled":
						enabled = q.Bool
					case "Location":
						e.loc = vec3(q.Raw)
					case "Rotation":
						e.rot = vec3(q.Raw)
					case "TerrainBlockDataAsset":
						if ref, err := db.Resolve(pk, q.ObjectIndex()); err == nil {
							e.asset = ref.Name
						}
					}
				}
				if enabled && e.asset != "" {
					vars[name] = append(vars[name], e)
				}
			}
		}
		return vars
	}
	var out []Block
	for _, c := range l.Clusters {
		vars := load(c.Asset)
		list, ok := vars[c.Variation]
		if !ok {
			list = vars["Default"]
		}
		// Autorenraum → Welt: Ursprung des Clusters ist die Ecke (Anker + 2, Anker + 2)
		dx := origin[0] + float64(c.AX+2)*TileSize - ClusterSpace[0]
		dy := origin[1] + float64(c.AY+2)*TileSize - ClusterSpace[1]
		for _, e := range list {
			out = append(out, Block{Asset: e.asset, Loc: [3]float64{e.loc[0] + dx, e.loc[1] + dy, e.loc[2]}, Rot: e.rot})
		}
	}
	return out
}

func vec3(b []byte) [3]float64 {
	var v [3]float64
	if len(b) >= 24 {
		for i := range v {
			v[i] = math.Float64frombits(binary.LittleEndian.Uint64(b[8*i:]))
		}
	}
	return v
}
