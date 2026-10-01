package cdn

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"mapviewer3d/mapdata"
)

// refPatch ist die Definition aus server.patch (aus dem Rohraster geschnitten).
func refPatch(h []uint16, m []byte, W, H, l, px, py int) []byte {
	step := 1 << l
	x0, y0 := px*PatchQuads*step, py*PatchQuads*step
	out := make([]byte, 3*N*N)
	for j := 0; j < N; j++ {
		y := y0 + j*step
		if y < 0 || y >= H {
			continue
		}
		for i := 0; i < N; i++ {
			x := x0 + i*step
			if x < 0 || x >= W {
				continue
			}
			k := y*W + x
			binary.LittleEndian.PutUint16(out[2*(j*N+i):], h[k])
			switch {
			case m != nil:
				out[2*N*N+j*N+i] = m[k]
			case h[k] != 0:
				out[2*N*N+j*N+i] = mapdata.MatLandscape
			}
		}
	}
	return out
}

func fakeMap(t *testing.T, dir string, W, H int) ([]uint16, []byte) {
	os.MkdirAll(dir, 0o755)
	h := make([]uint16, W*H)
	m := make([]byte, W*H)
	for y := 0; y < H; y++ {
		for x := 0; x < W; x++ {
			if x > 50 && y > 40 { // links/oben "Ozean" (0)
				h[y*W+x] = uint16(1 + (x*7+y*13)%60000)
				m[y*W+x] = byte(1 + (x+y)%3)
			}
		}
	}
	raw := make([]byte, 2*len(h))
	for i, v := range h {
		binary.LittleEndian.PutUint16(raw[2*i:], v)
	}
	os.WriteFile(filepath.Join(dir, mapdata.FileHeight), raw, 0o644)
	os.WriteFile(filepath.Join(dir, mapdata.FileMaterial), m, 0o644)
	meta := mapdata.Meta{Name: "fake", Source: "Fake_1", Title: "Fake & Co", Group: "Offene Welt", Width: W, Height: H, Spacing: 100, MinZ: -50, MaxZ: 500, Material: true}
	mb, _ := json.Marshal(meta)
	os.WriteFile(filepath.Join(dir, mapdata.FileMeta), mb, 0o644)
	return h, m
}

func TestPackAndStream(t *testing.T) {
	data := t.TempDir()
	W, H := 300, 260
	h, m := fakeMap(t, filepath.Join(data, "fake"), W, H)
	out := t.TempDir()
	state := filepath.Join(t.TempDir(), "state.json")
	if err := Pack(PackOptions{Data: data, Out: out, State: state, Log: t.Logf}); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(http.FileServer(http.Dir(out)))
	defer srv.Close()
	c := NewClient(t.TempDir(), srv.URL)
	ctx := context.Background()
	cat, err := c.Catalog(ctx)
	if err != nil || len(cat.Maps) != 1 || cat.Maps[0].Title != "Fake & Co" {
		t.Fatalf("Katalog: %v %+v", err, cat)
	}
	mp, err := c.Map(ctx, cat.Maps[0])
	if err != nil {
		t.Fatal(err)
	}
	for l := 0; l <= mp.Idx.MaxLevel; l++ {
		lv := mp.Idx.Levels[l]
		for py := -1; py <= lv.NY; py++ {
			for px := -1; px <= lv.NX; px++ {
				got, err := mp.Patch(ctx, l, px, py)
				if err != nil {
					t.Fatal(err)
				}
				want := refPatch(h, m, W, H, l, px, py)
				empty := true
				for _, b := range want[:2*N*N] {
					if b != 0 {
						empty = false
						break
					}
				}
				if empty {
					if got != nil {
						t.Fatalf("l%d %d,%d: leer erwartet", l, px, py)
					}
					continue
				}
				if string(got) != string(want) {
					t.Fatalf("l%d %d,%d: Kachel weicht ab", l, px, py)
				}
			}
		}
	}
	// zweiter Lauf: nichts mehr zu tun
	if err := Pack(PackOptions{Data: data, Out: out, State: state, Log: t.Logf}); err != nil {
		t.Fatal(err)
	}
}

func TestClientRejectsTamperedTile(t *testing.T) {
	data := t.TempDir()
	fakeMap(t, filepath.Join(data, "fake"), 200, 200)
	out := t.TempDir()
	if err := Pack(PackOptions{Data: data, Out: out}); err != nil {
		t.Fatal(err)
	}
	// eine Kachel verfälschen
	var tile string
	filepath.Walk(filepath.Join(out, "p"), func(p string, fi os.FileInfo, err error) error {
		if err == nil && !fi.IsDir() && tile == "" {
			tile = p
		}
		return nil
	})
	os.WriteFile(tile, Gzip(make([]byte, 3*N*N)), 0o644)
	srv := httptest.NewServer(http.FileServer(http.Dir(out)))
	defer srv.Close()
	c := NewClient("", srv.URL)
	c.HTTP.Timeout = 5e9
	ctx := context.Background()
	cat, _ := c.Catalog(ctx)
	mp, _ := c.Map(ctx, cat.Maps[0])
	bad := 0
	for l := range mp.Idx.Levels {
		lv := mp.Idx.Levels[l]
		for py := 0; py < lv.NY; py++ {
			for px := 0; px < lv.NX; px++ {
				if _, err := mp.Patch(ctx, l, px, py); err != nil {
					bad++
				}
			}
		}
	}
	if bad != 1 {
		t.Fatalf("%d verfälschte Kacheln erkannt, erwartet 1", bad)
	}
}

// Der echte Branch cdn (Arbeitskopie neben dem Projekt) muss sich lesen lassen und zu data/ passen.
func TestRealBranchMatchesData(t *testing.T) {
	branch := "../../GitHubVersion/data-branch"
	data := "../../data/survival_1"
	if _, err := os.Stat(filepath.Join(branch, "catalog.json")); err != nil {
		t.Skip("keine Arbeitskopie des Branches cdn")
	}
	raw, err := os.ReadFile(filepath.Join(data, mapdata.FileHeight))
	if err != nil {
		t.Skip("kein data/survival_1")
	}
	var meta mapdata.Meta
	mb, _ := os.ReadFile(filepath.Join(data, mapdata.FileMeta))
	json.Unmarshal(mb, &meta)
	h := make([]uint16, len(raw)/2)
	for i := range h {
		h[i] = binary.LittleEndian.Uint16(raw[2*i:])
	}
	mat, _ := os.ReadFile(filepath.Join(data, mapdata.FileMaterial))
	srv := httptest.NewServer(http.FileServer(http.Dir(branch)))
	defer srv.Close()
	c := NewClient("", srv.URL)
	ctx := context.Background()
	cat, err := c.Catalog(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var e *CatalogMap
	for i := range cat.Maps {
		if cat.Maps[i].Name == "survival_1" {
			e = &cat.Maps[i]
		}
	}
	if e == nil {
		t.Fatal("survival_1 fehlt im Katalog")
	}
	mp, err := c.Map(ctx, *e)
	if err != nil {
		t.Fatal(err)
	}
	checked := 0
	for l := 0; l <= mp.Idx.MaxLevel; l += 2 {
		lv := mp.Idx.Levels[l]
		for py := 0; py < lv.NY; py += 3 {
			for px := 0; px < lv.NX; px += 3 {
				got, err := mp.Patch(ctx, l, px, py)
				if err != nil {
					t.Fatal(err)
				}
				want := refPatch(h, mat, meta.Width, meta.Height, l, px, py)
				if got == nil {
					for _, b := range want[:2*N*N] {
						if b != 0 {
							t.Fatalf("l%d %d,%d: Kachel fehlt, Daten nicht leer", l, px, py)
						}
					}
					continue
				}
				if string(got) != string(want) {
					t.Fatalf("l%d %d,%d: weicht von data/ ab", l, px, py)
				}
				checked++
			}
		}
	}
	t.Logf("%d Kacheln stimmen mit data/survival_1 überein", checked)
}
