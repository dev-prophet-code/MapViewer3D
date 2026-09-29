// Package server stellt Weboberfläche und Karten-API des Map Editors bereit.
//
//	GET  /api/maps                              aktive Karten (Meta), laut Console
//	GET  /api/map/<name>/patch?l=&x=&y=         Geländestück (siehe patch)
//	GET  /api/map/<name>/mapimage               Kartenbild der Console (Oberfläche), X-Map-Bounds
//	POST /api/map/<name>/sample                 Geländehöhen an [[x,y],…] (cm) → [z|null]
//	GET  /api/buildables                        Bauteil-Katalog (index.json)
//	GET  /api/buildables/mesh/<id>.bin          Netz eines Bauteils
//	GET  /api/live/status                       ist die Live-Karte konfiguriert?
//	GET  /api/live/<name>/<feed>                players | overlays | poi | spice (Proxy zur Console)
//	                                            <name> ist der Kartenordner; Live-Name aus meta.json
//	GET  /api/live/base/<id>                    Bauteile einer Basis (Proxy zur Console)
//	GET  /api/icons/<datei>                     Kartensymbol der Console (zwischengespeichert)
//	GET  /api/version                           Versionsstand
package server

import (
	"encoding/binary"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"sync"

	"mapviewer3d/mapdata"
	"mapviewer3d/secure"
)

// Version steht in der Oberfläche und in CHANGELOG.md; beim Bauen per
// -ldflags "-X mapviewer3d/server.Version=…" überschreibbar.
var Version = "Beta.3"

// PatchQuads ist die Kantenlänge eines Geländestücks in Quads.
const PatchQuads = 128

// View ist eine Serverinstanz (Partition) einer Karte, z. B. Hagga Basin – PvP.
type View struct {
	Partition int    `json:"partition"`
	Label     string `json:"label"` // Anzeigename (config.json), sonst interner Name
	Internal  string `json:"internal"`
}

// MapInfo ist Meta plus vom Server ergänzte Werte.
type MapInfo struct {
	mapdata.Meta
	Views      []View `json:"views,omitempty"`
	Version    int64  `json:"version"` // Änderungszeit der Daten, für Cache-Busting
	PatchQuads int    `json:"patchQuads"`
	MaxLevel   int    `json:"maxLevel"`
}

type terrain struct {
	info MapInfo
	h    []uint16
	mat  []uint8
}

type Server struct {
	dataDir string
	mux     *http.ServeMux
	mu      sync.Mutex
	maps    map[string]*terrain
	layout  sync.Mutex

	liveMu     sync.RWMutex
	liveProxy  *liveProxy    // nil, solange keine Zugangsdaten eingerichtet sind
	store      *secure.Store // verschlüsselte Zugangsdaten
	stateDir   string        // nicht geheime Einstellungen (Instanznamen)
	labelCache sync.Map      // automatisch ermittelte Instanznamen
	iconMisses sync.Map      // Symbole, die die Console nicht hat (Name → bis wann)
	public     *publicGate   // nil = ohne Filter; sonst nur freigegebene Partitionen (public.go)
	fixed      bool          // Verbindung aus -config; Einrichtung im Browser gesperrt

	// RemoteSetup erlaubt Einrichtung und Instanznamen auch von anderen Rechnern.
	// Ohne diesen Schalter darf das nur ein Browser auf demselben Rechner.
	RemoteSetup bool
}

// lp liefert die aktuelle Verbindung zur Console oder nil.
func (s *Server) lp() *liveProxy {
	s.liveMu.RLock()
	defer s.liveMu.RUnlock()
	return s.liveProxy
}

func (s *Server) setLive(cfg *LiveConfig) {
	s.liveMu.Lock()
	defer s.liveMu.Unlock()
	if cfg == nil {
		s.liveProxy = nil
		return
	}
	s.liveProxy = newLiveProxy(cfg)
}

// New erstellt den Server. Sind im Store Zugangsdaten gespeichert, wird die
// Verbindung zur Console sofort hergestellt; sonst bleibt die Einrichtung offen.
func New(dataDir, webDir, stateDir string, store *secure.Store) *Server {
	s := &Server{dataDir: dataDir, mux: http.NewServeMux(), maps: map[string]*terrain{}, store: store, stateDir: stateDir}
	if store == nil {
		// feste Konfiguration (-config), siehe UseConfig
	} else if c, err := store.Load(); err == nil {
		s.setLive(&LiveConfig{APIBase: c.APIBase, Token: c.Token})
		log.Printf("Verbindung zur Console eingerichtet")
	} else if err != secure.ErrNotConfigured {
		log.Printf("Zugangsdaten nicht lesbar (%v) – bitte neu einrichten", err)
	} else {
		log.Printf("Noch keine Zugangsdaten – Einrichtung im Browser")
	}
	s.mux.HandleFunc("GET /api/setup", s.setupStatus)
	s.mux.HandleFunc("POST /api/setup", s.setupSave)
	s.mux.HandleFunc("DELETE /api/setup", s.setupDelete)
	s.mux.HandleFunc("GET /api/setup/labels", s.labelsGet)
	s.mux.HandleFunc("POST /api/setup/labels", s.labelsSave)
	s.mux.HandleFunc("GET /api/maps", s.listMaps)
	s.mux.HandleFunc("GET /api/map/{map}/patch", s.withMap(s.patch))
	s.mux.HandleFunc("POST /api/map/{map}/sample", s.withMap(s.sample))
	s.mux.HandleFunc("GET /api/buildables", s.buildablesIndex)
	s.mux.HandleFunc("GET /api/buildables/mesh/{file}", s.buildablesMesh)
	s.mux.HandleFunc("GET /api/live/status", s.liveStatus)
	s.mux.HandleFunc("GET /api/live/base/{id}", s.liveBase)
	s.mux.HandleFunc("GET /api/map/{map}/mapimage", s.withMap(s.mapImage))
	s.mux.HandleFunc("GET /api/live/{map}/{feed}", s.liveFeed)
	s.mux.HandleFunc("GET /api/icons/{file}", s.icon)
	s.mux.HandleFunc("GET /api/version", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]string{"version": Version})
	})
	static := http.FileServer(http.Dir(webDir))
	s.mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// Weboberfläche immer neu prüfen lassen (ETag/Last-Modified), sonst
		// hält der Browser nach Updates alte Module fest.
		w.Header().Set("Cache-Control", "no-cache")
		static.ServeHTTP(w, r)
	})
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.mux.ServeHTTP(w, r) }

var validName = regexp.MustCompile(`^[A-Za-z0-9_.-]+$`)

func (s *Server) mapDir(name string) string { return filepath.Join(s.dataDir, name) }

// withMap lädt die Karte aus dem Pfad und reicht sie an h weiter.
func (s *Server) withMap(h func(http.ResponseWriter, *http.Request, *terrain)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		name := r.PathValue("map")
		if !validName.MatchString(name) {
			http.Error(w, "ungültiger Kartenname", http.StatusBadRequest)
			return
		}
		t, err := s.load(name)
		if err != nil {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		h(w, r, t)
	}
}

func (s *Server) load(name string) (*terrain, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	dir := s.mapDir(name)
	st, err := os.Stat(filepath.Join(dir, mapdata.FileHeight))
	if err != nil {
		return nil, err
	}
	if t, ok := s.maps[name]; ok && t.info.Version == st.ModTime().Unix() {
		return t, nil
	}
	mj, err := os.ReadFile(filepath.Join(dir, mapdata.FileMeta))
	if err != nil {
		return nil, err
	}
	t := &terrain{}
	if err := json.Unmarshal(mj, &t.info.Meta); err != nil {
		return nil, err
	}
	t.info.Name = name
	t.info.Version = st.ModTime().Unix()
	raw, err := os.ReadFile(filepath.Join(dir, mapdata.FileHeight))
	if err != nil {
		return nil, err
	}
	t.h = make([]uint16, len(raw)/2)
	for i := range t.h {
		t.h[i] = binary.LittleEndian.Uint16(raw[2*i:])
	}
	if m, err := os.ReadFile(filepath.Join(dir, mapdata.FileMaterial)); err == nil && len(m) == len(t.h) {
		t.mat = m
	}
	n := max(t.info.Width, t.info.Height) - 1
	for (PatchQuads << t.info.MaxLevel) < n {
		t.info.MaxLevel++
	}
	t.info.PatchQuads = PatchQuads
	s.maps[name] = t
	log.Printf("%s geladen: %d×%d, %d Ebenen", name, t.info.Width, t.info.Height, t.info.MaxLevel+1)
	return t, nil
}

func (s *Server) listMaps(w http.ResponseWriter, r *http.Request) {
	entries, _ := os.ReadDir(s.dataDir)
	active := s.activeMaps() // nil = unbekannt, dann alle zeigen
	list := []MapInfo{}
	for _, e := range entries {
		if !e.IsDir() || !validName.MatchString(e.Name()) {
			continue
		}
		t, err := s.load(e.Name())
		if err != nil {
			continue
		}
		if active != nil && !active[t.info.Source] {
			continue
		}
		info := t.info
		info.Views = s.views(t)
		list = append(list, info)
	}
	sort.SliceStable(list, func(i, j int) bool {
		if list[i].Group != list[j].Group {
			return groupRank(list[i].Group) < groupRank(list[j].Group)
		}
		if ri, rj := mapRank(list[i].Source), mapRank(list[j].Source); ri != rj {
			return ri < rj
		}
		return list[i].Title < list[j].Title
	})
	writeJSON(w, list)
}

// Hagga Basin vor Deep Desert, danach alphabetisch
func mapRank(source string) int {
	switch source {
	case "Survival_1":
		return 0
	case "DeepDesert_1":
		return 1
	}
	return 2
}

func groupRank(g string) int {
	for i, o := range []string{"Offene Welt", "Städte", "Dungeons & Ecolabs", "Instanzen"} {
		if g == o {
			return i
		}
	}
	return 99
}

// patch liefert (PatchQuads+1)² Höhen (uint16) und danach ebenso viele
// Materialbytes, ab Rasterposition (x,y)·PatchQuads·2^l mit Schrittweite 2^l.
// Punkte außerhalb der Karte sind 0.
func (s *Server) patch(w http.ResponseWriter, r *http.Request, t *terrain) {
	l, px, py := atoi(r, "l"), atoi(r, "x"), atoi(r, "y")
	if l < 0 || l > t.info.MaxLevel {
		http.Error(w, "ungültige Ebene", http.StatusBadRequest)
		return
	}
	step := 1 << l
	x0, y0 := px*PatchQuads*step, py*PatchQuads*step
	n := PatchQuads + 1
	out := make([]byte, 3*n*n)
	W, H := t.info.Width, t.info.Height
	for j := 0; j < n; j++ {
		y := y0 + j*step
		if y < 0 || y >= H {
			continue
		}
		for i := 0; i < n; i++ {
			x := x0 + i*step
			if x < 0 || x >= W {
				continue
			}
			k := y*W + x
			binary.LittleEndian.PutUint16(out[2*(j*n+i):], t.h[k])
			switch {
			case t.mat != nil:
				out[2*n*n+j*n+i] = t.mat[k]
			case t.h[k] != 0:
				out[2*n*n+j*n+i] = mapdata.MatLandscape
			}
		}
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Cache-Control", "max-age=3600")
	w.Write(out)
}
