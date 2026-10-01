package cdn

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// DefaultBases: Quellen des Branches cdn. Die erste ist GitHub selbst, die zweite ein
// Spiegel (jsDelivr), falls GitHub drosselt oder nicht erreichbar ist.
var DefaultBases = []string{
	"https://raw.githubusercontent.com/dev-prophet-code/MapViewer3D/cdn/",
	"https://cdn.jsdelivr.net/gh/dev-prophet-code/MapViewer3D@cdn/",
}

const (
	catalogTTL = 10 * time.Minute
	maxFetch   = 64 << 20
)

// Client holt Kartendaten aus dem Branch cdn, prüft sie gegen die Prüfsummen des Katalogs
// und legt sie auf der Platte ab (Kacheln sind unveränderlich, der Katalog wird nach
// catalogTTL neu geholt; ohne Netz dient der zuletzt gespeicherte).
type Client struct {
	Bases []string
	Cache string // Ordner für den Zwischenspeicher
	HTTP  *http.Client

	mu     sync.Mutex
	cat    *Catalog
	catAt  time.Time
	failAt time.Time // letzter Fehlschlag beim Katalog: danach kurz nicht erneut versuchen
	maps   map[string]*Map
	flight map[string]*call
}

type call struct {
	done chan struct{}
	b    []byte
	err  error
}

// NewClient: bases leer = DefaultBases.
func NewClient(cache string, bases ...string) *Client {
	if len(bases) == 0 {
		bases = DefaultBases
	}
	for i, b := range bases {
		if !strings.HasSuffix(b, "/") {
			bases[i] = b + "/"
		}
	}
	return &Client{Bases: bases, Cache: cache, HTTP: &http.Client{Timeout: 60 * time.Second},
		maps: map[string]*Map{}, flight: map[string]*call{}}
}

// fetch lädt rel von der ersten Quelle, die antwortet; gleiche Anfragen laufen nur einmal.
// verify prüft den Inhalt (Quelle mit falschem Inhalt gilt als fehlgeschlagen).
func (c *Client) fetch(ctx context.Context, rel string, verify func([]byte) error) ([]byte, error) {
	c.mu.Lock()
	if f, ok := c.flight[rel]; ok {
		c.mu.Unlock()
		select {
		case <-f.done:
			return f.b, f.err
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	f := &call{done: make(chan struct{})}
	c.flight[rel] = f
	c.mu.Unlock()
	f.b, f.err = c.fetchOnce(ctx, rel, verify)
	c.mu.Lock()
	delete(c.flight, rel)
	c.mu.Unlock()
	close(f.done)
	return f.b, f.err
}

func (c *Client) fetchOnce(ctx context.Context, rel string, verify func([]byte) error) ([]byte, error) {
	var last error
	for attempt := 0; attempt < 2; attempt++ {
		for _, base := range c.Bases {
			req, _ := http.NewRequestWithContext(ctx, "GET", base+rel, nil)
			req.Header.Set("User-Agent", "MapViewer3D-cdn")
			resp, err := c.HTTP.Do(req)
			if err != nil {
				last = err
				continue
			}
			b, err := io.ReadAll(io.LimitReader(resp.Body, maxFetch))
			resp.Body.Close()
			if resp.StatusCode != 200 || err != nil {
				last = fmt.Errorf("%s: HTTP %d", base+rel, resp.StatusCode)
				continue
			}
			if verify != nil {
				if err := verify(b); err != nil {
					last = fmt.Errorf("%s: %w", base+rel, err)
					continue
				}
			}
			return b, nil
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(1500 * time.Millisecond):
		}
	}
	return nil, last
}

func (c *Client) cachePath(rel string) string { return filepath.Join(c.Cache, filepath.FromSlash(rel)) }

func (c *Client) readCache(rel string) []byte {
	if c.Cache == "" {
		return nil
	}
	b, err := os.ReadFile(c.cachePath(rel))
	if err != nil {
		return nil
	}
	return b
}

func (c *Client) writeCache(rel string, b []byte) {
	if c.Cache == "" {
		return
	}
	p := c.cachePath(rel)
	if os.MkdirAll(filepath.Dir(p), 0o755) != nil {
		return
	}
	tmp := p + ".tmp"
	if os.WriteFile(tmp, b, 0o644) == nil {
		os.Rename(tmp, p)
	}
}

// immutable holt eine unveränderliche Datei (Zwischenspeicher zuerst, dann Netz).
func (c *Client) immutable(ctx context.Context, rel string, verify func([]byte) error) ([]byte, error) {
	if b := c.readCache(rel); b != nil && (verify == nil || verify(b) == nil) {
		return b, nil
	}
	b, err := c.fetch(ctx, rel, verify)
	if err != nil {
		return nil, err
	}
	c.writeCache(rel, b)
	return b, nil
}

// Catalog liefert den Katalog (höchstens catalogTTL alt; bei Netzfehler der letzte bekannte).
func (c *Client) Catalog(ctx context.Context) (*Catalog, error) {
	c.mu.Lock()
	if c.cat != nil && time.Since(c.catAt) < catalogTTL {
		cat := c.cat
		c.mu.Unlock()
		return cat, nil
	}
	recent := time.Since(c.failAt) < 30*time.Second
	c.mu.Unlock()
	var b []byte
	var err error
	if recent {
		err = errors.New("Katalog zuletzt nicht erreichbar")
	} else {
		b, err = c.fetchCatalog(ctx)
	}
	if err == nil {
		c.writeCache("catalog.json", b)
	} else if b = c.readCache("catalog.json"); b == nil {
		c.mu.Lock()
		cat := c.cat
		c.failAt = time.Now()
		c.mu.Unlock()
		if cat != nil {
			return cat, nil
		}
		return nil, err
	} else {
		c.mu.Lock()
		c.failAt = time.Now()
		c.mu.Unlock()
	}
	var cat Catalog
	if err := json.Unmarshal(b, &cat); err != nil {
		return nil, err
	}
	c.mu.Lock()
	c.cat, c.catAt = &cat, time.Now()
	c.mu.Unlock()
	return &cat, nil
}

func (c *Client) fetchCatalog(ctx context.Context) ([]byte, error) {
	return c.fetch(ctx, "catalog.json", func(b []byte) error {
		var x Catalog
		if err := json.Unmarshal(b, &x); err != nil || x.Format != Format {
			return errors.New("kein gültiger Katalog")
		}
		return nil
	})
}

// Map ist eine Karte aus dem Katalog mit geladenem Index.
type Map struct {
	c     *Client
	Entry CatalogMap
	Idx   Index

	lru sync.Mutex
	hot map[string][]byte
	ord []string
}

// Map lädt den Index einer Karte (geprüft gegen die Prüfsumme aus dem Katalog).
func (c *Client) Map(ctx context.Context, e CatalogMap) (*Map, error) {
	key := e.File + "@" + e.SHA256
	c.mu.Lock()
	if m, ok := c.maps[key]; ok {
		c.mu.Unlock()
		return m, nil
	}
	c.mu.Unlock()
	rel := "m/" + e.SHA256 + ".json"
	b := c.readCache(rel)
	if b == nil || sha(b) != e.SHA256 {
		var err error
		b, err = c.fetch(ctx, e.File, func(b []byte) error {
			if sha(b) != e.SHA256 {
				return errors.New("Prüfsumme des Index stimmt nicht")
			}
			return nil
		})
		if err != nil {
			return nil, err
		}
		c.writeCache(rel, b)
	}
	m := &Map{c: c, Entry: e, hot: map[string][]byte{}}
	if err := json.Unmarshal(b, &m.Idx); err != nil {
		return nil, err
	}
	c.mu.Lock()
	c.maps[key] = m
	c.mu.Unlock()
	return m, nil
}

// Patch liefert die Kachel (Ebene l, Spalte px, Zeile py) im Format von /patch
// (N*N Höhen uint16 LE, dann N*N Materialien); nil = leer (Ozean, außerhalb).
func (m *Map) Patch(ctx context.Context, l, px, py int) ([]byte, error) {
	if l < 0 || l >= len(m.Idx.Levels) {
		return nil, nil
	}
	lv := m.Idx.Levels[l]
	if px < 0 || py < 0 || px >= lv.NX || py >= lv.NY {
		return nil, nil
	}
	ci := lv.Cells[py*lv.NX+px]
	if ci < 0 || int(ci) >= len(m.Idx.IDs) {
		return nil, nil
	}
	id := m.Idx.IDs[ci]
	m.lru.Lock()
	if p, ok := m.hot[id]; ok {
		m.lru.Unlock()
		return p, nil
	}
	m.lru.Unlock()
	rel := "p/" + id[:2] + "/" + id[2:] + ".z"
	var patch []byte
	_, err := m.c.immutable(ctx, rel, func(z []byte) error {
		raw, err := Unpack(z)
		if err != nil {
			return err
		}
		if TileID(raw) != id {
			return errors.New("Kachel passt nicht zu ihrer Kennung")
		}
		patch = Patch(raw)
		return nil
	})
	if err != nil {
		return nil, err
	}
	if patch == nil { // aus dem Zwischenspeicher: verify lief dort ebenfalls und füllte patch
		return nil, errors.New("Kachel nicht lesbar")
	}
	m.lru.Lock()
	if len(m.ord) >= 96 {
		delete(m.hot, m.ord[0])
		m.ord = m.ord[1:]
	}
	m.hot[id] = patch
	m.ord = append(m.ord, id)
	m.lru.Unlock()
	return patch, nil
}

// Meshes: Bauteil-Katalog.

// BuildIndex liefert buildables/index.json (geprüft).
func (c *Client) BuildIndex(ctx context.Context) ([]byte, error) {
	cat, err := c.Catalog(ctx)
	if err != nil || cat.Buildables == nil {
		return nil, errors.New("kein Bauteil-Katalog")
	}
	want := cat.Buildables.Index
	rel := "buildables/index." + want[:16] + ".json"
	if b := c.readCache(rel); b != nil && sha(b) == want {
		return b, nil
	}
	b, err := c.fetch(ctx, "buildables/index.json", func(b []byte) error {
		if sha(b) != want {
			return errors.New("Prüfsumme stimmt nicht")
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	c.writeCache(rel, b)
	return b, nil
}

// BuildMesh liefert buildables/mesh/<id>.bin (geprüft).
func (c *Client) BuildMesh(ctx context.Context, id string) ([]byte, error) {
	cat, err := c.Catalog(ctx)
	if err != nil || cat.Buildables == nil {
		return nil, errors.New("kein Bauteil-Katalog")
	}
	want, ok := cat.Buildables.Meshes[id]
	if !ok {
		return nil, os.ErrNotExist
	}
	return c.immutable(ctx, "buildables/mesh/"+id+".bin", func(b []byte) error {
		if sha(b)[:16] != want {
			return errors.New("Prüfsumme stimmt nicht")
		}
		return nil
	})
}
