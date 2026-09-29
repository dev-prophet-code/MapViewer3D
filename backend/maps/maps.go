// Package maps ordnet die Karten des Servers (Namen wie in der Console, z. B.
// Survival_1, DeepDesert_1, SH_Arrakeen) ihren Levels in den Paks zu.
package maps

import (
	"fmt"
	"path"
	"regexp"
	"sort"
	"strings"
)

// Def beschreibt, wie eine Karte gebaut wird.
type Def struct {
	ID     string   // Ordnername in data/, z. B. survival_1
	Name   string   // Name in der Console
	Title  string   // Anzeigename
	Group  string   // Gruppe in der Kartenauswahl
	Level  string   // Paketpfad des Hauptlevels
	Dirs   []string // Levelordner, deren Inhalt zur Karte gehört
	Live   string   // Kartenname der Live-API (leer = keine Live-Daten)
	Repeat string   // Präfix von Geländekacheln, die über Bounds wiederholt werden
	Bounds *[4]float64
	Layout int // Coriolis-Layout der Deep Desert (DA_DeepDesert_1_Layout_NN); 0 = keines
}

// Always: Hagga Basin (Survival_1) läuft immer, steht aber nicht in der
// Kartenliste der Console (mapsList).
var Always = []string{"Survival_1"}

// Fallback, falls die Console nicht erreichbar ist.
var DefaultActive = []string{"Survival_1", "DeepDesert_1"}

// Bekannte Sonderfälle; alles andere wird aus dem Namen abgeleitet.
var known = map[string]Def{
	"Survival_1": {Title: "Hagga Basin", Group: "Offene Welt", Live: "HaggaBasin"},
	"DeepDesert_1": {Title: "Deep Desert", Group: "Offene Welt", Live: "DeepDesert",
		// Das Gelände der Deep Desert setzt der Server zur Laufzeit aus Dünen-Vorlagen
		// zusammen (Coriolis); hier wird die Vorlage über die Kartenfläche wiederholt.
		Repeat: "/Game/Dune/Maps/Biomes/Arrakis/SoS/heightmap/SoS_Arrakis_DunesLow04_x",
		Bounds: &[4]float64{-1177656, 1072344, -1177066, 1072934}},
}

// Resolve bildet Kartennamen auf Level-Pakete ab (paths = alle Paketnamen).
func Resolve(names []string, paths []string) ([]Def, []string) {
	byBase := map[string][]string{}
	for _, p := range paths {
		byBase[path.Base(p)] = append(byBase[path.Base(p)], p)
	}
	var defs []Def
	var missing []string
	seen := map[string]bool{}
	for _, n := range names {
		if seen[n] {
			continue
		}
		seen[n] = true
		cands := byBase[n]
		if len(cands) == 0 {
			missing = append(missing, n)
			continue
		}
		sort.Strings(cands)
		level := cands[0]
		d := known[n]
		d.Name, d.Level, d.ID = n, level, strings.ToLower(n)
		d.Dirs = []string{path.Dir(level) + "/"}
		if d.Title == "" {
			d.Title = Pretty(n)
		}
		if d.Group == "" {
			d.Group = group(n)
		}
		defs = append(defs, d)
	}
	sort.Slice(defs, func(i, j int) bool {
		if defs[i].Group != defs[j].Group {
			return groupOrder(defs[i].Group) < groupOrder(defs[j].Group)
		}
		return defs[i].Title < defs[j].Title
	})
	return defs, missing
}

func group(n string) string {
	switch {
	case strings.HasPrefix(n, "SH_"):
		return "Städte"
	case strings.Contains(n, "Dungeon"), strings.Contains(n, "Ecolab"):
		return "Dungeons & Ecolabs"
	default:
		return "Instanzen"
	}
}

func groupOrder(g string) int {
	for i, o := range []string{"Offene Welt", "Städte", "Dungeons & Ecolabs", "Instanzen"} {
		if g == o {
			return i
		}
	}
	return 99
}

var camel = regexp.MustCompile(`([a-z])([A-Z])`)

// Pretty macht aus CB_Story_OrbitalMonitor „Story · Orbital Monitor“.
func Pretty(n string) string {
	parts := strings.Split(n, "_")
	var out []string
	for _, p := range parts {
		if p == "CB" || p == "DLC" || p == "Arrakis" || p == "" {
			continue
		}
		out = append(out, camel.ReplaceAllString(p, "$1 $2"))
	}
	if len(out) == 0 {
		return n
	}
	if len(out) > 1 {
		return fmt.Sprintf("%s · %s", out[0], strings.Join(out[1:], " "))
	}
	return out[0]
}

// OpenWorld meldet, ob eine Karte Live-Daten hat (Hagga Basin, Deep Desert).
func (d Def) OpenWorld() bool { return d.Live != "" }

// ParseActive liest aus der Ausgabe von mapsList der Console die aktiven Karten,
// also die mit mindestens einer zugewiesenen Serverinstanz („Assigned: n“, n > 0).
// Dynamische Instanzkarten ohne laufenden Server (Story, Dungeons) fallen heraus.
func ParseActive(stdout string) []string {
	names := append([]string{}, Always...)
	for _, l := range strings.Split(stdout, "\n") {
		f := strings.Fields(l)
		if len(f) < 2 || !strings.HasPrefix(f[1], "Current:") {
			continue
		}
		for i := 0; i+1 < len(f); i++ {
			if f[i] == "Assigned:" && f[i+1] != "0" {
				names = append(names, f[0])
			}
		}
	}
	return names
}
