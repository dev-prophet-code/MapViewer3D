package cdn

import (
	"encoding/json"

	"mapviewer3d/mapdata"
)

// Catalog ist catalog.json: eine Zeile je Karte (mit Prüfsumme des Index) und die
// Prüfsummen des Bauteil-Katalogs.
type Catalog struct {
	Format     int           `json:"format"`
	Maps       []CatalogMap  `json:"maps"`
	Buildables *BuildablesCh `json:"buildables"`
}

// CatalogMap: Meta der Karte plus Verweis auf ihren Index.
type CatalogMap struct {
	File       string `json:"file"`   // m/<karte>.json
	SHA256     string `json:"sha256"` // des Index (volle 64 Stellen)
	PatchQuads int    `json:"patchQuads"`
	MaxLevel   int    `json:"maxLevel"`
	mapdata.Meta
}

// BuildablesCh: SHA-256 von buildables/index.json und je Modell die ersten 16 Stellen.
type BuildablesCh struct {
	Index  string            `json:"index"`
	Meshes map[string]string `json:"meshes"`
}

// Index ist m/<karte>.json: welche Kachel an welcher Stelle liegt.
type Index struct {
	Format     int             `json:"format"`
	PatchQuads int             `json:"patchQuads"`
	MaxLevel   int             `json:"maxLevel"`
	Meta       json.RawMessage `json:"meta"`
	IDs        []string        `json:"ids"`
	Levels     []Level         `json:"levels"`
}

type Level struct {
	NX    int     `json:"nx"`
	NY    int     `json:"ny"`
	Cells []int32 `json:"cells"` // Index in IDs, -1 = leer
}
