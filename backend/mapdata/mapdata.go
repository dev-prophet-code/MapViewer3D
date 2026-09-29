// Package mapdata beschreibt das Datenformat einer extrahierten Karte
// (data/<karte>/), das Extraktor und Viewer-Server gemeinsam nutzen.
package mapdata

// Dateinamen innerhalb des Kartenordners.
const (
	FileMeta     = "meta.json"
	FileHeight   = "height.u16"  // uint16 LE je Stützpunkt, 0 = keine Daten
	FileMaterial = "material.u8" // uint8 je Stützpunkt, siehe Mat*

	// DirBuildables liegt direkt unter dem Datenverzeichnis, nicht je Karte.
	DirBuildables = "buildables"
)

// Materialien in material.u8.
const (
	MatNone           = 0
	MatLandscape      = 1
	MatBlockLandscape = 2
	MatRock           = 3
)

// Meta ist der Inhalt von meta.json.
type Meta struct {
	Name     string  `json:"name"`   // Ordnername
	Source   string  `json:"source"` // Kartenname in der Console
	Title    string  `json:"title"`
	Group    string  `json:"group"`
	Live     string  `json:"live,omitempty"`   // Kartenname der Live-API
	Layout   int     `json:"layout,omitempty"` // Deep Desert: Coriolis-Layout dieses Geländes (coriolisLayout der Console)
	Width    int     `json:"width"`
	Height   int     `json:"height"`
	OriginX  float64 `json:"originX"` // Welt-X (cm) der Spalte 0
	OriginY  float64 `json:"originY"` // Welt-Y (cm) der Zeile 0
	Spacing  float64 `json:"spacing"` // cm zwischen Stützpunkten
	MinZ     float64 `json:"minZ"`    // cm, entspricht Höhenwert 1
	MaxZ     float64 `json:"maxZ"`    // cm, entspricht Höhenwert 65535
	Comps    int     `json:"components"`
	Blocks   int     `json:"blocks"`
	Meshes   int     `json:"meshes"`
	Levels   int     `json:"levels"`
	Material bool    `json:"material"`
}
