// Package assets verbindet IoStore-Container und Zen-Pakete: Pakete per ID
// laden und Objektverweise (Imports) paketübergreifend auflösen.
package assets

import (
	"encoding/binary"
	"fmt"
	"strings"
	"sync"

	"mapviewer3d/iostore"
	"mapviewer3d/zen"
)

type pkgInfo struct {
	c        *iostore.Container
	index    int
	path     string
	imported []uint64
}

type DB struct {
	Store  *iostore.Store
	Script zen.ScriptObjects
	pkgs   map[uint64]*pkgInfo
	byPath map[string]uint64 // Paketname (/Game/...) -> ID
	mu     sync.Mutex
	cache  map[uint64]*zen.Package
}

// Open liest alle Container eines Verzeichnisses samt Paketverzeichnis.
func Open(dir string) (*DB, error) {
	s, err := iostore.OpenDir(dir)
	if err != nil {
		return nil, err
	}
	sob, err := s.Read(iostore.ChunkID{Type: iostore.ChunkScriptObjects})
	if err != nil {
		return nil, err
	}
	so, err := zen.ReadScriptObjects(sob)
	if err != nil {
		return nil, err
	}
	db := &DB{Store: s, Script: so, pkgs: map[uint64]*pkgInfo{}, byPath: map[string]uint64{}, cache: map[uint64]*zen.Package{}}
	for _, c := range s.Containers {
		for path, idx := range c.Files {
			id := c.ChunkIDOf(idx)
			if id.Type != iostore.ChunkExportBundleData {
				continue
			}
			db.pkgs[id.ID] = &pkgInfo{c: c, index: idx, path: path}
			db.byPath[PackageName(path)] = id.ID
		}
	}
	for _, c := range s.Containers {
		if err := db.readContainerHeader(c); err != nil {
			return nil, fmt.Errorf("%s: %w", c.Name, err)
		}
	}
	return db, nil
}

// PackageName wandelt einen Dateipfad der Container in einen Paketnamen um.
func PackageName(path string) string {
	p := strings.TrimPrefix(path, "../../../")
	p = strings.TrimSuffix(strings.TrimSuffix(p, ".uasset"), ".umap")
	if rest, ok := strings.CutPrefix(p, "DuneSandbox/Content/"); ok {
		return "/Game/" + rest
	}
	if rest, ok := strings.CutPrefix(p, "Engine/Content/"); ok {
		return "/Engine/" + rest
	}
	// Plugins: .../Plugins/.../<Name>/Content/... -> /<Name>/...
	if i := strings.Index(p, "/Content/"); i >= 0 {
		head := p[:i]
		name := head[strings.LastIndex(head, "/")+1:]
		return "/" + name + "/" + p[i+len("/Content/"):]
	}
	return "/" + p
}

// readContainerHeader liest die importierten Pakete je Paket (Container-Header V2).
func (db *DB) readContainerHeader(c *iostore.Container) error {
	id := iostore.ChunkID{ID: c.ContainerID, Type: iostore.ChunkContainerHeader}
	if !c.Has(id) {
		return nil
	}
	b, err := c.Read(id)
	if err != nil {
		return err
	}
	le := binary.LittleEndian
	n := int(le.Uint32(b[16:]))
	ids := make([]uint64, n)
	for i := range ids {
		ids[i] = le.Uint64(b[20+8*i:])
	}
	p := 20 + 8*n + 4 // Beginn der StoreEntries
	const entrySize = 24
	for i, pid := range ids {
		e := p + i*entrySize
		num := int(le.Uint32(b[e+8:]))
		off := int(le.Uint32(b[e+12:]))
		info := db.pkgs[pid]
		if info == nil {
			continue
		}
		for k := 0; k < num; k++ {
			info.imported = append(info.imported, le.Uint64(b[e+8+off+8*k:]))
		}
	}
	return nil
}

// Load lädt ein Paket per ID (zwischengespeichert).
func (db *DB) Load(id uint64) (*zen.Package, error) {
	db.mu.Lock()
	if pk, ok := db.cache[id]; ok {
		db.mu.Unlock()
		return pk, nil
	}
	db.mu.Unlock()
	info := db.pkgs[id]
	if info == nil {
		return nil, fmt.Errorf("Paket %016x unbekannt", id)
	}
	b, err := info.c.ReadIndex(info.index)
	if err != nil {
		return nil, err
	}
	pk, err := zen.Parse(b, db.Script)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", info.path, err)
	}
	pk.ID, pk.Path = id, PackageName(info.path)
	db.mu.Lock()
	db.cache[id] = pk
	db.mu.Unlock()
	return pk, nil
}

// LoadPath lädt ein Paket per Name, z. B. /Game/Dune/Maps/...
func (db *DB) LoadPath(name string) (*zen.Package, error) {
	id, ok := db.byPath[name]
	if !ok {
		return nil, fmt.Errorf("Paket %s nicht gefunden", name)
	}
	return db.Load(id)
}

// Forget verwirft zwischengespeicherte Pakete (Speicher sparen).
func (db *DB) Forget(id uint64) {
	db.mu.Lock()
	delete(db.cache, id)
	db.mu.Unlock()
}

// Paths liefert alle Paketnamen.
func (db *DB) Paths() []string {
	out := make([]string, 0, len(db.byPath))
	for p := range db.byPath {
		out = append(out, p)
	}
	return out
}

// Ref ist ein aufgelöster Objektverweis.
type Ref struct {
	Pkg    *zen.Package
	Export int // Index im Paket, -1 bei Script-Objekten
	Name   string
}

func (r Ref) Valid() bool { return r.Pkg != nil && r.Export >= 0 }

// Resolve löst einen FPackageIndex (aus einer ObjectProperty) im Kontext von pk auf.
func (db *DB) Resolve(pk *zen.Package, idx int32) (Ref, error) {
	switch {
	case idx == 0:
		return Ref{Export: -1}, nil
	case idx > 0:
		i := int(idx - 1)
		if i >= len(pk.Exports) {
			return Ref{Export: -1}, fmt.Errorf("Export %d außerhalb", i)
		}
		return Ref{Pkg: pk, Export: i, Name: pk.Exports[i].Name}, nil
	}
	i := int(-idx - 1)
	if i >= len(pk.Imports) {
		return Ref{Export: -1}, fmt.Errorf("Import %d außerhalb", i)
	}
	return db.ResolveObjectIndex(pk, pk.Imports[i])
}

// ResolveObjectIndex löst einen FPackageObjectIndex auf.
func (db *DB) ResolveObjectIndex(pk *zen.Package, oi uint64) (Ref, error) {
	switch oi >> 62 {
	case 0:
		i := int(oi & (1<<62 - 1))
		if i < len(pk.Exports) {
			return Ref{Pkg: pk, Export: i, Name: pk.Exports[i].Name}, nil
		}
	case 1:
		return Ref{Export: -1, Name: db.Script[oi]}, nil
	case 2:
		pkgIdx := int((oi >> 32) & 0x3fffffff)
		hashIdx := int(oi & 0xffffffff)
		info := db.pkgs[pk.ID]
		if info == nil || pkgIdx >= len(info.imported) || hashIdx >= len(pk.ExportHashes) {
			return Ref{Export: -1}, fmt.Errorf("Import nicht auflösbar")
		}
		target, err := db.Load(info.imported[pkgIdx])
		if err != nil {
			return Ref{Export: -1}, err
		}
		h := pk.ExportHashes[hashIdx]
		for i, e := range target.Exports {
			if e.PublicHash == h {
				return Ref{Pkg: target, Export: i, Name: e.Name}, nil
			}
		}
		return Ref{Pkg: target, Export: -1}, fmt.Errorf("Export %x nicht in %s", h, target.Path)
	}
	return Ref{Export: -1}, nil
}

// ClassName liefert den Klassennamen eines Exports, auch für Blueprint-Klassen.
func (db *DB) ClassName(pk *zen.Package, e zen.Export) string {
	if e.ClassIndex>>62 == 2 {
		if r, err := db.ResolveObjectIndex(pk, e.ClassIndex); err == nil {
			return r.Name
		}
	}
	return e.Class
}
