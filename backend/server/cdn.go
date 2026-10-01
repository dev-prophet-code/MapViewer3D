package server

import (
	"context"
	"encoding/binary"
	"errors"
	"log"
	"net/http"
	"path/filepath"
	"strconv"
	"time"

	"mapviewer3d/cdn"
)

// Karten und Bauteil-Modelle kommen standardmäßig aus dem Branch `cdn` des Repositorys
// (cdn/): Der Viewer streamt die Kacheln, die er braucht, prüft sie gegen den Katalog und
// legt sie im Zwischenspeicher ab. Ein lokaler Ordner data/ dient als Rückfall (kein Netz,
// Karten, die der Branch nicht kennt) und mit `-cdn off` als alleinige Quelle.

var errNotInCatalog = errors.New("Karte nicht im Katalog")

// SetCDN schaltet das Streaming ein (nil = nur lokale Daten).
func (s *Server) SetCDN(c *cdn.Client) { s.cdn = c }

func (s *Server) catalog() (*cdn.Catalog, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	return s.cdn.Catalog(ctx)
}

// cdnHas: kennt der Branch die Karte (z. B. ein Coriolis-Layout)?
func (s *Server) cdnHas(name string) bool {
	if s.cdn == nil {
		return false
	}
	cat, err := s.catalog()
	if err != nil {
		return false
	}
	for _, m := range cat.Maps {
		if m.Name == name {
			return true
		}
	}
	return false
}

// remoteNames: Karten des Katalogs (ohne Netz und ohne Zwischenspeicher leer).
func (s *Server) remoteNames() []string {
	if s.cdn == nil {
		return nil
	}
	cat, err := s.catalog()
	if err != nil {
		return nil
	}
	var out []string
	for _, m := range cat.Maps {
		if validName.MatchString(m.Name) {
			out = append(out, m.Name)
		}
	}
	return out
}

func (s *Server) loadRemote(name string) (*terrain, error) {
	cat, err := s.catalog()
	if err != nil {
		return nil, err
	}
	var e *cdn.CatalogMap
	for i := range cat.Maps {
		if cat.Maps[i].Name == name {
			e = &cat.Maps[i]
			break
		}
	}
	if e == nil {
		return nil, errNotInCatalog
	}
	ver, _ := strconv.ParseInt(e.SHA256[:12], 16, 64)
	s.mu.Lock()
	if t, ok := s.maps[name]; ok && t.remote != nil && t.info.Version == ver {
		s.mu.Unlock()
		return t, nil
	}
	s.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	m, err := s.cdn.Map(ctx, *e)
	if err != nil {
		return nil, err
	}
	t := &terrain{remote: m}
	t.info.Meta = e.Meta
	t.info.Name = name
	t.info.Version = ver
	t.info.MaxLevel = m.Idx.MaxLevel
	t.info.PatchQuads = PatchQuads
	s.mu.Lock()
	s.maps[name] = t
	s.mu.Unlock()
	log.Printf("%s aus dem Katalog geladen: %d×%d, %d Ebenen", name, t.info.Width, t.info.Height, t.info.MaxLevel+1)
	return t, nil
}

// remotePatch schreibt die Kachel im Format von /patch (leere Kachel = Nullen).
func (s *Server) remotePatch(w http.ResponseWriter, r *http.Request, t *terrain, l, px, py int) {
	b, err := t.remote.Patch(r.Context(), l, px, py)
	if err != nil {
		log.Printf("%s: Kachel %d/%d/%d: %v", t.info.Name, l, px, py, err)
		http.Error(w, "Kachel nicht verfügbar", http.StatusBadGateway)
		return
	}
	if b == nil {
		b = make([]byte, 3*cdn.N*cdn.N)
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Cache-Control", "max-age=3600")
	w.Write(b)
}

// rawHeight liefert den Höhenwert des Rasters an Spalte x, Zeile y (0 = keine Daten).
func (t *terrain) rawHeight(x, y int) uint16 {
	if t.remote == nil {
		return t.h[y*t.info.Width+x]
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	p, err := t.remote.Patch(ctx, 0, x/cdn.PatchQuads, y/cdn.PatchQuads)
	if err != nil || p == nil {
		return 0
	}
	return binary.LittleEndian.Uint16(p[2*((y%cdn.PatchQuads)*cdn.N+x%cdn.PatchQuads):])
}

// Bauteil-Katalog

func (s *Server) buildablesIndexRemote(w http.ResponseWriter, r *http.Request) bool {
	if s.cdn == nil {
		return false
	}
	b, err := s.cdn.BuildIndex(r.Context())
	if err != nil {
		return false
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "max-age=600")
	w.Write(b)
	return true
}

func (s *Server) buildablesMeshRemote(w http.ResponseWriter, r *http.Request, file string) bool {
	if s.cdn == nil {
		return false
	}
	id := file[:len(file)-len(".bin")]
	b, err := s.cdn.BuildMesh(r.Context(), id)
	if err != nil {
		return false
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Cache-Control", "max-age=3600")
	w.Write(b)
	return true
}

// cdnCacheDir: Zwischenspeicher der gestreamten Daten (im Einstellungsordner, nicht im Projektordner).
func cdnCacheDir(state string) string { return filepath.Join(state, "cdncache") }
