package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"time"

	"mapviewer3d/maps"
)

// activeMaps liefert die Karten mit laufender Serverinstanz (Console, 60 s
// zwischengespeichert) oder nil, wenn das nicht bekannt ist.
func (s *Server) activeMaps() map[string]bool {
	if s.lp() == nil {
		return nil
	}
	c := s.lp().get("/api/map/status", 60*time.Second)
	if c.status != http.StatusOK {
		return nil
	}
	var st struct {
		Maps struct {
			Stdout string `json:"stdout"`
		} `json:"maps"`
	}
	if json.Unmarshal(c.body, &st) != nil || st.Maps.Stdout == "" {
		return nil
	}
	out := map[string]bool{}
	for _, n := range maps.ParseActive(st.Maps.Stdout) {
		out[n] = true
	}
	return out
}

// liveName ist der Kartenname der Live-API (aus meta.json, ersatzweise config.json).
func (s *Server) liveName(t *terrain) string {
	if t.info.Live != "" {
		return t.info.Live
	}
	if s.lp() != nil {
		return s.lp().cfg.Maps[t.info.Name]
	}
	return ""
}

// consoleMapInfo: Kartenbild und Kalibrierung, wie die Console sie für ihre Live Map nutzt.
type consoleMapInfo struct {
	Image string  `json:"image"`
	MinX  float64 `json:"minX"`
	MaxX  float64 `json:"maxX"`
	MinY  float64 `json:"minY"`
	MaxY  float64 `json:"maxY"`
	FlipY bool    `json:"flipY"`
}

func (s *Server) consoleMaps(liveName string) (*consoleMapInfo, error) {
	c := s.lp().get("/api/map/markers?map="+liveName, time.Hour)
	if c.status != http.StatusOK {
		return nil, fmt.Errorf("Console: HTTP %d", c.status)
	}
	var doc struct {
		Maps map[string]consoleMapInfo `json:"maps"`
	}
	if err := json.Unmarshal(c.body, &doc); err != nil {
		return nil, err
	}
	info, ok := doc.Maps[liveName]
	if !ok || info.Image == "" {
		return nil, fmt.Errorf("kein Kartenbild für %s", liveName)
	}
	return &info, nil
}

func (s *Server) mapImageDir() string { return filepath.Join(s.stateDir, "mapimages") }

// mapImage liefert das Kartenbild der Console (auf der Platte zwischengespeichert)
// und seine Weltausdehnung im Header X-Map-Bounds (minX,maxX,minY,maxY,flipY).
func (s *Server) mapImage(w http.ResponseWriter, r *http.Request, t *terrain) {
	name := s.liveName(t)
	if s.lp() == nil || name == "" {
		http.NotFound(w, r)
		return
	}
	info, err := s.consoleMaps(name)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	// Zwischenspeicher im Einstellungsordner: das Bild stammt vom eingetragenen
	// Server und gehört nicht in den (weitergegebenen) Projektordner.
	os.MkdirAll(s.mapImageDir(), 0o755)
	file := filepath.Join(s.mapImageDir(), t.info.Name+".png")
	if st, err := os.Stat(file); err != nil || time.Since(st.ModTime()) > 24*time.Hour {
		c := s.lp().get(info.Image, time.Hour)
		if c.status != http.StatusOK {
			http.Error(w, "Kartenbild nicht abrufbar", http.StatusBadGateway)
			return
		}
		os.WriteFile(file, c.body, 0o644)
	}
	w.Header().Set("X-Map-Bounds", fmt.Sprintf("%g,%g,%g,%g,%t", info.MinX, info.MaxX, info.MinY, info.MaxY, info.FlipY))
	w.Header().Set("Cache-Control", "max-age=3600")
	http.ServeFile(w, r, file)
}

// views liefert die laufenden Partitionen einer Karte laut Console, sortiert
// nach Anzeigename-Rang (PvE, PvP, Creative …) und Nummer.
func (s *Server) views(t *terrain) []View {
	name := s.liveName(t)
	if s.lp() == nil || name == "" {
		return nil
	}
	c := s.lp().get("/api/map/partitions", 60*time.Second)
	if c.status != http.StatusOK {
		return nil
	}
	var doc struct {
		Rows []struct {
			Map       string `json:"map"`
			Partition int    `json:"partition_id"`
			Name      string `json:"name"`
			Alive     bool   `json:"alive"`
		} `json:"rows"`
	}
	if json.Unmarshal(c.body, &doc) != nil {
		return nil
	}
	var allowed map[int]bool
	if s.public != nil {
		allowed = s.public.partitions()
	}
	var out []View
	for _, r := range doc.Rows {
		if r.Map != name || !r.Alive || (allowed != nil && !allowed[r.Partition]) {
			continue
		}
		out = append(out, View{Partition: r.Partition, Internal: r.Name})
	}
	for i := range out {
		out[i].Label = s.partitionLabel(t, out[i].Partition, out[i].Internal)
	}
	rank := func(l string) int {
		for i, k := range []string{"PvE", "PVE", "PvP", "PVP", "Creative"} {
			if len(l) >= len(k) && l[:len(k)] == k {
				return i / 2
			}
		}
		return 9
	}
	sort.Slice(out, func(i, j int) bool {
		if rank(out[i].Label) != rank(out[j].Label) {
			return rank(out[i].Label) < rank(out[j].Label)
		}
		return out[i].Partition < out[j].Partition
	})
	return out
}

// coriolisFor meldet den Coriolis-Zyklus der Deep Desert (Layout, Seed, nächster
// Wechsel) aus der Marker-Antwort der Console (5 min zwischengespeichert); nil bei
// Karten ohne Layout oder wenn die Console nichts meldet.
func (s *Server) coriolisFor(t *terrain) *Coriolis {
	name := s.liveName(t)
	if s.lp() == nil || name != "DeepDesert" {
		return nil
	}
	c := s.lp().get("/api/map/markers?map="+name, 5*time.Minute)
	if c.status != http.StatusOK {
		return nil
	}
	var doc struct {
		Layout    *int   `json:"coriolisLayout"`
		Seed      string `json:"coriolisSeed"`
		NextCycle string `json:"coriolisNextCycleAt"`
	}
	if json.Unmarshal(c.body, &doc) != nil || doc.Layout == nil {
		return nil
	}
	return &Coriolis{Layout: *doc.Layout, Seed: doc.Seed, NextCycle: doc.NextCycle,
		Match: t.info.Layout == *doc.Layout, Building: s.building.Load() == int32(*doc.Layout)}
}
