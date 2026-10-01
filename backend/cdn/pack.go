package cdn

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"mapviewer3d/mapdata"
)

// PackOptions steuert Pack.
type PackOptions struct {
	Data  string   // extrahierte Karten (data/<karte>/…, data/buildables)
	Out   string   // Arbeitskopie des Branches cdn
	Only  []string // nur diese Kartenordner (leer = alle)
	State string   // Datei, in der gemerkt wird, welcher Stand je Karte schon gepackt ist (leer = immer alles)
	Log   func(format string, args ...any)
}

func (o *PackOptions) logf(f string, a ...any) {
	if o.Log != nil {
		o.Log(f, a...)
	}
}

// Pack schneidet die extrahierten Karten in Kacheln und schreibt sie nach Out.
// Vorhandenes bleibt erhalten (Kacheln sind inhaltsadressiert und werden nie gelöscht),
// unveränderte Karten werden übersprungen. Zum Schluss entsteht catalog.json neu.
func Pack(o PackOptions) error {
	state := map[string]string{}
	if o.State != "" {
		if b, err := os.ReadFile(o.State); err == nil {
			json.Unmarshal(b, &state)
		}
	}
	names := o.Only
	if len(names) == 0 {
		ents, err := os.ReadDir(o.Data)
		if err != nil {
			return err
		}
		for _, e := range ents {
			if _, err := os.Stat(filepath.Join(o.Data, e.Name(), mapdata.FileMeta)); err == nil {
				names = append(names, e.Name())
			}
		}
	}
	for _, name := range names {
		sig, err := mapSig(filepath.Join(o.Data, name))
		if err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
		_, haveIdx := os.Stat(filepath.Join(o.Out, "m", name+".json"))
		if state[name] == sig && haveIdx == nil {
			o.logf("%s: unverändert", name)
			continue
		}
		if err := packMap(o, name); err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
		state[name] = sig
		saveState(o.State, state)
	}
	if err := packBuildables(o); err != nil {
		return fmt.Errorf("buildables: %w", err)
	}
	return writeCatalog(o)
}

func saveState(path string, st map[string]string) {
	if path == "" {
		return
	}
	b, _ := json.MarshalIndent(st, "", " ")
	os.WriteFile(path, b, 0o644)
}

func mapSig(dir string) (string, error) {
	var parts []string
	for _, f := range []string{mapdata.FileMeta, mapdata.FileHeight, mapdata.FileMaterial} {
		st, err := os.Stat(filepath.Join(dir, f))
		if err != nil {
			if f == mapdata.FileMaterial {
				continue
			}
			return "", err
		}
		parts = append(parts, fmt.Sprintf("%s:%d:%d", f, st.Size(), st.ModTime().UnixNano()))
	}
	return strings.Join(parts, "|"), nil
}

func packMap(o PackOptions, name string) error {
	dir := filepath.Join(o.Data, name)
	metaRaw, err := os.ReadFile(filepath.Join(dir, mapdata.FileMeta))
	if err != nil {
		return err
	}
	var meta mapdata.Meta
	if err := json.Unmarshal(metaRaw, &meta); err != nil {
		return err
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, metaRaw); err != nil {
		return err
	}
	rawH, err := os.ReadFile(filepath.Join(dir, mapdata.FileHeight))
	if err != nil {
		return err
	}
	W, Hh := meta.Width, meta.Height
	if len(rawH) != 2*W*Hh {
		return fmt.Errorf("height.u16 hat %d Werte, erwartet %d", len(rawH)/2, W*Hh)
	}
	H := make([]uint16, W*Hh)
	for i := range H {
		H[i] = binary.LittleEndian.Uint16(rawH[2*i:])
	}
	rawH = nil
	M, _ := os.ReadFile(filepath.Join(dir, mapdata.FileMaterial))
	if len(M) != len(H) {
		M = nil
	}

	n := max(W, Hh) - 1
	maxLevel := 0
	for (PatchQuads << maxLevel) < n {
		maxLevel++
	}
	table := map[string]int{}
	var ids []string
	var levels []Level
	stored, reused, empty, bytesOut := 0, 0, 0, 0
	heights := make([]uint16, N*N)
	mats := make([]byte, N*N)
	for l := 0; l <= maxLevel; l++ {
		step := 1 << l
		nx := (W + PatchQuads*step - 1) / (PatchQuads * step)
		ny := (Hh + PatchQuads*step - 1) / (PatchQuads * step)
		cells := make([]int32, nx*ny)
		for i := range cells {
			cells[i] = -1
		}
		for py := 0; py < ny; py++ {
			for px := 0; px < nx; px++ {
				clear(heights)
				clear(mats)
				any := false
				x0, y0 := px*PatchQuads*step, py*PatchQuads*step
				for j := 0; j < N; j++ {
					y := y0 + j*step
					if y >= Hh {
						break
					}
					for i := 0; i < N; i++ {
						x := x0 + i*step
						if x >= W {
							break
						}
						k := y*W + x
						h := H[k]
						heights[j*N+i] = h
						if M != nil {
							mats[j*N+i] = M[k]
						} else if h != 0 {
							mats[j*N+i] = mapdata.MatLandscape
						}
						if h != 0 {
							any = true
						}
					}
				}
				if !any {
					empty++
					continue
				}
				raw := EncodeTile(heights, mats)
				id := TileID(raw)
				idx, ok := table[id]
				if !ok {
					idx = len(ids)
					ids = append(ids, id)
					table[id] = idx
					file := tilePath(o.Out, id)
					if _, err := os.Stat(file); err != nil {
						z := Gzip(raw)
						if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
							return err
						}
						if err := os.WriteFile(file, z, 0o644); err != nil {
							return err
						}
						bytesOut += len(z)
						stored++
					} else {
						reused++
					}
				} else {
					reused++
				}
				cells[py*nx+px] = int32(idx)
			}
		}
		levels = append(levels, Level{NX: nx, NY: ny, Cells: cells})
	}
	idx := Index{Format: Format, PatchQuads: PatchQuads, MaxLevel: maxLevel, Meta: compact.Bytes(), IDs: ids, Levels: levels}
	if err := os.MkdirAll(filepath.Join(o.Out, "m"), 0o755); err != nil {
		return err
	}
	if err := writeJSON(filepath.Join(o.Out, "m", name+".json"), idx, ""); err != nil {
		return err
	}
	o.logf("%s: %d Ebenen, %d neue Kacheln (%.1f MB), %d geteilt, %d leer", name, maxLevel+1, stored, float64(bytesOut)/1048576, reused, empty)
	return nil
}

func tilePath(out, id string) string { return filepath.Join(out, "p", id[:2], id[2:]+".z") }

func writeJSON(path string, v any, indent string) error {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if indent != "" {
		enc.SetIndent("", indent)
	}
	if err := enc.Encode(v); err != nil {
		return err
	}
	out := bytes.TrimRight(b.Bytes(), "\n")
	return os.WriteFile(path, out, 0o644)
}

var meshFile = regexp.MustCompile(`^[0-9]+\.bin$`)

func sha(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }

// packBuildables kopiert den Bauteil-Katalog und merkt sich Prüfsummen für Index und Modelle.
func packBuildables(o PackOptions) error {
	src := filepath.Join(o.Data, mapdata.DirBuildables)
	indexBytes, err := os.ReadFile(filepath.Join(src, "index.json"))
	if err != nil {
		return nil // ohne Katalog bleibt der alte stehen
	}
	dst := filepath.Join(o.Out, "buildables")
	if err := os.MkdirAll(filepath.Join(dst, "mesh"), 0o755); err != nil {
		return err
	}
	if err := writeIfChanged(filepath.Join(dst, "index.json"), indexBytes); err != nil {
		return err
	}
	ents, err := os.ReadDir(filepath.Join(src, "mesh"))
	if err != nil {
		return err
	}
	n := 0
	for _, e := range ents {
		if !meshFile.MatchString(e.Name()) {
			continue
		}
		b, err := os.ReadFile(filepath.Join(src, "mesh", e.Name()))
		if err != nil {
			return err
		}
		if err := writeIfChanged(filepath.Join(dst, "mesh", e.Name()), b); err != nil {
			return err
		}
		n++
	}
	o.logf("buildables: %d Modelle", n)
	return nil
}

func writeIfChanged(path string, b []byte) error {
	if old, err := os.ReadFile(path); err == nil && bytes.Equal(old, b) {
		return nil
	}
	return os.WriteFile(path, b, 0o644)
}

// writeCatalog baut catalog.json aus den Dateien in Out (m/*.json und buildables/).
func writeCatalog(o PackOptions) error {
	ents, err := os.ReadDir(filepath.Join(o.Out, "m"))
	if err != nil {
		return err
	}
	var files []string
	for _, e := range ents {
		if strings.HasSuffix(e.Name(), ".json") {
			files = append(files, e.Name())
		}
	}
	sort.Strings(files)
	var maps []json.RawMessage
	for _, f := range files {
		b, err := os.ReadFile(filepath.Join(o.Out, "m", f))
		if err != nil {
			return err
		}
		var idx Index
		if err := json.Unmarshal(b, &idx); err != nil {
			return fmt.Errorf("m/%s: %w", f, err)
		}
		// Reihenfolge wie im Addon-Werkzeug: file, sha256, patchQuads, maxLevel, danach die Felder der Meta
		var eb bytes.Buffer
		eb.WriteString(fmt.Sprintf(`{"file":%q,"sha256":%q,"patchQuads":%d,"maxLevel":%d`, "m/"+f, sha(b), idx.PatchQuads, idx.MaxLevel))
		dec := json.NewDecoder(bytes.NewReader(idx.Meta))
		dec.Token() // {
		for dec.More() {
			k, _ := dec.Token()
			var v json.RawMessage
			dec.Decode(&v)
			kb, _ := json.Marshal(k)
			eb.WriteByte(',')
			eb.Write(kb)
			eb.WriteByte(':')
			eb.Write(v)
		}
		eb.WriteByte('}')
		maps = append(maps, json.RawMessage(eb.Bytes()))
	}
	var cat bytes.Buffer
	cat.WriteString(fmt.Sprintf(`{"format":%d,"maps":[`, Format))
	for i, m := range maps {
		if i > 0 {
			cat.WriteByte(',')
		}
		cat.Write(m)
	}
	cat.WriteString(`],"buildables":`)
	if idxBytes, err := os.ReadFile(filepath.Join(o.Out, "buildables", "index.json")); err == nil {
		type mesh struct {
			n  int
			id string
			h  string
		}
		var list []mesh
		ments, _ := os.ReadDir(filepath.Join(o.Out, "buildables", "mesh"))
		for _, e := range ments {
			if !meshFile.MatchString(e.Name()) {
				continue
			}
			b, err := os.ReadFile(filepath.Join(o.Out, "buildables", "mesh", e.Name()))
			if err != nil {
				return err
			}
			id := strings.TrimSuffix(e.Name(), ".bin")
			n, _ := strconv.Atoi(id)
			list = append(list, mesh{n, id, sha(b)[:16]})
		}
		// Reihenfolge wie bei JavaScript-Objekten mit Zahlenschlüsseln: aufsteigend nach Zahl
		sort.Slice(list, func(a, b int) bool { return list[a].n < list[b].n })
		cat.WriteString(fmt.Sprintf(`{"index":%q,"meshes":{`, sha(idxBytes)))
		for i, m := range list {
			if i > 0 {
				cat.WriteByte(',')
			}
			cat.WriteString(fmt.Sprintf(`%q:%q`, m.id, m.h))
		}
		cat.WriteString(`}}`)
	} else {
		cat.WriteString(`null`)
	}
	cat.WriteByte('}')
	var pretty bytes.Buffer
	if err := json.Indent(&pretty, cat.Bytes(), "", " "); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(o.Out, "catalog.json"), pretty.Bytes(), 0o644); err != nil {
		return err
	}
	o.logf("catalog.json: %d Karten", len(maps))
	return nil
}
