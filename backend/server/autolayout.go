package server

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"mapviewer3d/assets"
	"mapviewer3d/mapbuild"
	"mapviewer3d/mapdata"
	"mapviewer3d/maps"
)

// Nach jedem Coriolis-Sturm wählt der Spielserver ein neues Layout der Deep Desert.
// Mit den Spieldateien (-paks) baut der Viewer das Gelände dazu selbst, sobald die Console
// das neue Layout meldet, und hält die jüngsten Stände vor. Ohne Spieldateien zeigt er
// weiter das passende vorhandene Gelände oder die Dünenvorlage und warnt (siehe pickLayouts).

const (
	layoutPoll  = 5 * time.Minute  // wie oft die Console nach dem Layout gefragt wird
	layoutRetry = 30 * time.Minute // Pause nach einem fehlgeschlagenen Bau
	keepLayouts = 3                // so viele Layout-Stände bleiben auf der Platte
)

// EnableAutoLayout schaltet den automatischen Bau ein; paks ist der Ordner mit .utoc/.ucas.
func (s *Server) EnableAutoLayout(paks string) {
	s.paks = paks
	go func() {
		for {
			s.ensureLayout()
			time.Sleep(layoutPoll)
		}
	}()
}

// liveLayout fragt das aktuelle Coriolis-Layout der Deep Desert bei der Console ab.
func (s *Server) liveLayout() (layout int, ok bool) {
	if s.lp() == nil {
		return 0, false
	}
	c := s.lp().get("/api/map/markers?map=DeepDesert", layoutPoll)
	if c.status != http.StatusOK {
		return 0, false
	}
	var doc struct {
		Layout *int `json:"coriolisLayout"`
	}
	if json.Unmarshal(c.body, &doc) != nil || doc.Layout == nil {
		return 0, false
	}
	return *doc.Layout, true
}

func layoutDir(dataDir string, n int) string {
	return filepath.Join(dataDir, fmt.Sprintf("deepdesert_1_l%02d", n))
}

// ensureLayout baut das Gelände des aktuellen Layouts, falls es fehlt.
func (s *Server) ensureLayout() {
	n, ok := s.liveLayout()
	if !ok {
		return
	}
	dir := layoutDir(s.dataDir, n)
	if _, err := os.Stat(filepath.Join(dir, mapdata.FileMeta)); err == nil {
		s.pruneLayouts(n)
		return
	}
	if t, failed := s.layoutFailed.Load().(time.Time); failed && s.layoutFailedFor.Load() == int32(n) && time.Since(t) < layoutRetry {
		return
	}
	s.building.Store(int32(n))
	defer s.building.Store(0)
	log.Printf("Coriolis-Layout %d: Gelände fehlt, baue es aus %s …", n, s.paks)
	t0 := time.Now()
	if err := s.buildLayout(n, dir); err != nil {
		log.Printf("Coriolis-Layout %d: Bau fehlgeschlagen: %v", n, err)
		s.layoutFailed.Store(time.Now())
		s.layoutFailedFor.Store(int32(n))
		return
	}
	log.Printf("Coriolis-Layout %d: Gelände fertig (%.0f s)", n, time.Since(t0).Seconds())
	s.pruneLayouts(n)
}

func (s *Server) buildLayout(n int, dir string) error {
	db, err := assets.Open(s.paks)
	if err != nil {
		return err
	}
	defs, _ := maps.Resolve([]string{"DeepDesert_1"}, db.Paths())
	if len(defs) == 0 || defs[0].Repeat == "" {
		return fmt.Errorf("Deep Desert nicht in den Spieldateien gefunden")
	}
	def := defs[0]
	def.Layout = n
	def.ID = filepath.Base(dir)
	res, err := mapbuild.Build(db, def)
	if err != nil {
		return err
	}
	tmp := dir + ".tmp"
	os.RemoveAll(tmp)
	if err := res.Write(tmp); err != nil {
		os.RemoveAll(tmp)
		return err
	}
	os.RemoveAll(dir)
	return os.Rename(tmp, dir)
}

// pruneLayouts behält das aktuelle Layout und die jüngsten Stände, der Rest wird gelöscht.
func (s *Server) pruneLayouts(current int) {
	entries, _ := os.ReadDir(s.dataDir)
	type dirInfo struct {
		name string
		mod  time.Time
	}
	var ds []dirInfo
	for _, e := range entries {
		if !e.IsDir() || !strings.HasPrefix(e.Name(), "deepdesert_1_l") || strings.HasSuffix(e.Name(), ".tmp") {
			continue
		}
		if e.Name() == filepath.Base(layoutDir(s.dataDir, current)) {
			continue
		}
		if st, err := e.Info(); err == nil {
			ds = append(ds, dirInfo{e.Name(), st.ModTime()})
		}
	}
	sort.Slice(ds, func(i, j int) bool { return ds[i].mod.After(ds[j].mod) })
	for i := keepLayouts - 1; i < len(ds); i++ { // -1: das aktuelle zählt mit
		if err := os.RemoveAll(filepath.Join(s.dataDir, ds[i].name)); err == nil {
			log.Printf("Altes Layout %s entfernt", ds[i].name)
			s.mu.Lock()
			delete(s.maps, ds[i].name)
			s.mu.Unlock()
		}
	}
}
