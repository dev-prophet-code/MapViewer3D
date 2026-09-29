// extract baut Karten für den Map Viewer aus den Serverpaks.
//
//	go run ./cmd/extract                         aktive Karten der offenen Welt (Liste aus der Console)
//	go run ./cmd/extract -maps Survival_1,SH_Arrakeen
//	go run ./cmd/extract -list                   nur anzeigen, was gebaut würde
//	go run ./cmd/extract -layout 8,9             Deep Desert mit diesen Coriolis-Layouts (Standard: auto = aktuelles Layout laut Console;
//	                                             all = alle Layouts der Paks; none = ohne Layout, nur Dünenvorlage)
//
// Ausgabe je Karte in <out>/<id>/ (Format siehe Paket mapdata), dazu
// kartenübergreifend <out>/buildables/ (Bauteil-Katalog für die Basen in 3D).
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"mapviewer3d/assets"
	"mapviewer3d/buildables"
	"mapviewer3d/layout"
	"mapviewer3d/mapbuild"
	"mapviewer3d/mapdata"
	"mapviewer3d/maps"
	"mapviewer3d/secure"
)

func main() {
	paks := flag.String("paks", "../paks", "Verzeichnis mit .utoc/.ucas")
	out := flag.String("out", "../data", "Ausgabeverzeichnis")
	state := flag.String("state", "../state", "verschlüsselte Zugangsdaten (für die Liste der aktiven Karten)")
	only := flag.String("maps", "", "Kartennamen wie in der Console, kommagetrennt (leer = alle aktiven)")
	list := flag.Bool("list", false, "nur die Kartenliste ausgeben")
	layouts := flag.String("layout", "auto", "Deep Desert: Coriolis-Layouts (Nummern kommagetrennt, auto, all oder none)")
	build := flag.Bool("buildables", true, "Bauteil-Katalog für die 3D-Basen exportieren")
	flag.Parse()
	t0 := time.Now()

	names := maps.DefaultActive
	if *only != "" {
		names = strings.Split(*only, ",")
	} else if active, err := activeMaps(*state); err != nil {
		log.Printf("Console nicht abfragbar (%v), nehme Standardliste", err)
	} else {
		names = active
	}

	db, err := assets.Open(*paks)
	if err != nil {
		log.Fatal(err)
	}
	defs, missing := maps.Resolve(names, db.Paths())
	if *only == "" {
		// Ohne Auswahl nur die offene Welt (Hagga Basin, Deep Desert): Städte und
		// Instanzen haben in der Console keine Live-Daten.
		var open []maps.Def
		for _, d := range defs {
			if d.OpenWorld() {
				open = append(open, d)
			}
		}
		defs = open
	}
	for _, m := range missing {
		log.Printf("%s: kein Level in den Paks gefunden", m)
	}
	defs = withLayouts(db, defs, *layouts, *state)
	if *list {
		for _, d := range defs {
			fmt.Printf("%-22s %-20s %-12s %s\n", d.Name, d.Title, d.Group, d.Level)
		}
		return
	}
	for _, d := range defs {
		t := time.Now()
		res, err := mapbuild.Build(db, d)
		if err != nil {
			log.Printf("%s: %v", d.Name, err)
			continue
		}
		if err := res.Write(filepath.Join(*out, d.ID)); err != nil {
			log.Fatal(err)
		}
		log.Printf("%s fertig (%.1f s)", d.Name, time.Since(t).Seconds())
	}
	if *build {
		idx, err := buildables.Export(db, filepath.Join(*out, mapdata.DirBuildables))
		if err != nil {
			log.Fatal(err)
		}
		log.Printf("Bauteil-Katalog: %d Zeilen, %d Netze", len(idx.Rows), len(idx.Meshes))
	}
	log.Printf("fertig (%.1f s)", time.Since(t0).Seconds())
}

// consoleGet ruft die API der Console ab; die Zugangsdaten kommen aus dem
// verschlüsselten Speicher des Viewers.
func consoleGet(state, path string, out any) error {
	store, err := secure.Open(filepath.Join(state, "credentials.enc"), "")
	if err != nil {
		return err
	}
	cfg, err := store.Load()
	if err != nil {
		return err
	}
	req, _ := http.NewRequest(http.MethodGet, cfg.APIBase+path, nil)
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	resp, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("Console: HTTP %d", resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

// activeMaps fragt die Console nach den Karten mit laufender Serverinstanz.
func activeMaps(state string) ([]string, error) {
	var st struct {
		Maps struct {
			Stdout string `json:"stdout"`
		} `json:"maps"`
	}
	if err := consoleGet(state, "/api/map/status", &st); err != nil {
		return nil, err
	}
	return maps.ParseActive(st.Maps.Stdout), nil
}

// currentLayout liefert das aktuelle Coriolis-Layout der Deep Desert laut Console.
func currentLayout(state string) (int, error) {
	var doc struct {
		Layout *int `json:"coriolisLayout"`
	}
	if err := consoleGet(state, "/api/map/markers?map=DeepDesert", &doc); err != nil {
		return 0, err
	}
	if doc.Layout == nil {
		return 0, fmt.Errorf("Console meldet kein coriolisLayout")
	}
	return *doc.Layout, nil
}

// withLayouts vervielfacht die Deep Desert je Layout (Ordner deepdesert_1_l08 …).
// Der Viewer wählt zur Laufzeit das Gelände, das zum Layout des Servers passt.
func withLayouts(db *assets.DB, defs []maps.Def, spec, state string) []maps.Def {
	if spec == "none" {
		return defs
	}
	var out []maps.Def
	for _, d := range defs {
		if d.Repeat == "" {
			out = append(out, d)
			continue
		}
		var nums []int
		switch spec {
		case "all":
			nums = layout.Available(db)
			sort.Ints(nums)
		case "auto":
			n, err := currentLayout(state)
			if err != nil {
				log.Printf("%s: Layout unbekannt (%v) – baue ohne Layout; mit -layout N festlegen", d.Name, err)
				out = append(out, d)
				continue
			}
			nums = []int{n}
		default:
			for _, f := range strings.Split(spec, ",") {
				n, err := strconv.Atoi(strings.TrimSpace(f))
				if err != nil || n < 0 {
					log.Fatalf("-layout: ungültige Nummer %q", f)
				}
				nums = append(nums, n)
			}
		}
		for _, n := range nums {
			c := d
			c.Layout = n
			c.ID = fmt.Sprintf("%s_l%02d", d.ID, n)
			out = append(out, c)
		}
	}
	return out
}
