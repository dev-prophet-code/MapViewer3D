package server

import (
	"testing"

	"mapviewer3d/mapdata"
)

func terr(name, source string, layout int) *terrain {
	return &terrain{info: MapInfo{Meta: mapdata.Meta{Name: name, Source: source, Layout: layout}}}
}

// Ohne Verbindung zur Console (Layout des Servers unbekannt) gewinnt das Gelände
// ohne Layout, sonst das mit der kleinsten Nummer; andere Karten bleiben unberührt.
func TestPickLayouts(t *testing.T) {
	s := &Server{}
	names := func(ts []*terrain) []string {
		var out []string
		for _, x := range ts {
			out = append(out, x.info.Name)
		}
		return out
	}
	got := names(s.pickLayouts([]*terrain{
		terr("survival_1", "Survival_1", 0),
		terr("deepdesert_1_l09", "DeepDesert_1", 9),
		terr("deepdesert_1", "DeepDesert_1", 0),
		terr("deepdesert_1_l08", "DeepDesert_1", 8),
	}))
	want := []string{"survival_1", "deepdesert_1"}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("mit Dünenvorlage: %v, erwartet %v", got, want)
	}
	got = names(s.pickLayouts([]*terrain{terr("dd9", "DeepDesert_1", 9), terr("dd8", "DeepDesert_1", 8)}))
	if len(got) != 1 || got[0] != "dd8" {
		t.Fatalf("ohne Dünenvorlage: %v, erwartet [dd8]", got)
	}
}
