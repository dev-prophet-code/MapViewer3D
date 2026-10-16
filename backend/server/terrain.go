package server

import (
	"encoding/json"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"

	"mapviewer3d/mapdata"
)

// heightAt liefert die Geländehöhe (cm) an Weltposition x/y (cm), bilinear.
func (t *terrain) heightAt(x, y float64) (float64, bool) {
	m := t.info.Meta
	fx := (x - m.OriginX) / m.Spacing
	fy := (y - m.OriginY) / m.Spacing
	if fx < 0 || fy < 0 || fx > float64(m.Width-1) || fy > float64(m.Height-1) {
		return 0, false
	}
	i, j := int(fx), int(fy)
	i1, j1 := min(i+1, m.Width-1), min(j+1, m.Height-1)
	u, v := fx-float64(i), fy-float64(j)
	unit := (m.MaxZ - m.MinZ) / 65534
	var sum, wsum float64
	for _, c := range [4]struct {
		x, y int
		w    float64
	}{{i, j, (1 - u) * (1 - v)}, {i1, j, u * (1 - v)}, {i, j1, (1 - u) * v}, {i1, j1, u * v}} {
		if h := t.rawHeight(c.x, c.y); h != 0 && c.w > 0 {
			sum += c.w * (m.MinZ + float64(h-1)*unit)
			wsum += c.w
		}
	}
	if wsum == 0 {
		return 0, false
	}
	return sum / wsum, true
}

// sample: POST [[x,y],…] (cm) → [z|null] (cm)
func (s *Server) sample(w http.ResponseWriter, r *http.Request, t *terrain) {
	var pts [][2]float64
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<20)).Decode(&pts); err != nil || len(pts) > 200000 {
		http.Error(w, "erwartet [[x,y],…] (max. 200000)", http.StatusBadRequest)
		return
	}
	out := make([]*float64, len(pts))
	order := make([]int, len(pts))
	for i := range order {
		order[i] = i
	}
	if t.remote != nil && len(pts) > 1 && t.info.Spacing > 0 {
		m := t.info.Meta
		span := float64(PatchQuads) * m.Spacing
		cell := func(idx int) (int, int) {
			return int((pts[idx][0] - m.OriginX) / span), int((pts[idx][1] - m.OriginY) / span)
		}
		sort.Slice(order, func(a, b int) bool {
			ax, ay := cell(order[a])
			bx, by := cell(order[b])
			if ay != by {
				return ay < by
			}
			return ax < bx
		})
	}
	for _, i := range order {
		if r.Context().Err() != nil {
			return
		}
		p := pts[i]
		if z, ok := t.heightAt(p[0], p[1]); ok {
			z = math.Round(z)
			out[i] = &z
		}
	}
	writeJSON(w, out)
}

func (s *Server) buildablesIndex(w http.ResponseWriter, r *http.Request) {
	if s.buildablesIndexRemote(w, r) {
		return
	}
	f := filepath.Join(s.dataDir, mapdata.DirBuildables, "index.json")
	if _, err := os.Stat(f); err != nil {
		writeJSON(w, map[string]any{"rows": map[string]any{}, "meshes": []any{}})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "max-age=600")
	http.ServeFile(w, r, f)
}

var binFile = regexp.MustCompile(`^[0-9]+\.bin$`)

func (s *Server) buildablesMesh(w http.ResponseWriter, r *http.Request) {
	file := r.PathValue("file")
	if !binFile.MatchString(file) {
		http.NotFound(w, r)
		return
	}
	if s.buildablesMeshRemote(w, r, file) {
		return
	}
	w.Header().Set("Cache-Control", "max-age=3600")
	http.ServeFile(w, r, filepath.Join(s.dataDir, mapdata.DirBuildables, "mesh", file))
}
