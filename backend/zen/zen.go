// Package zen liest UE5-Zen-Pakete (IoStore-Format, UE 5.1/5.2-Layout) mit
// getaggten Properties, wie sie im Dune-Awakening-Serverbuild vorliegen.
package zen

import (
	"encoding/binary"
	"fmt"
	"math"
	"unicode/utf16"
)

// ReadNameBatch liest eine FNameBatch (Anzahl, Bytes, Hash-Version, Hashes, Header, Strings).
func ReadNameBatch(b []byte, p int) ([]string, int, error) {
	le := binary.LittleEndian
	n := int(le.Uint32(b[p:]))
	if n == 0 {
		return nil, p + 4, nil
	}
	p += 4
	p += 4     // NumStringBytes
	p += 8     // HashVersion
	p += 8 * n // Hashes
	hdr := p
	p += 2 * n
	names := make([]string, n)
	for i := 0; i < n; i++ {
		h := binary.BigEndian.Uint16(b[hdr+2*i:])
		utf := h&0x8000 != 0
		l := int(h & 0x7fff)
		if utf {
			u := make([]uint16, l)
			for j := range u {
				u[j] = le.Uint16(b[p+2*j:])
			}
			names[i] = string(utf16.Decode(u))
			p += 2 * l
		} else {
			names[i] = string(b[p : p+l])
			p += l
		}
	}
	return names, p, nil
}

// ScriptObjects bildet globale Script-Objekt-Indizes (Klassen) auf Namen ab.
type ScriptObjects map[uint64]string

// ReadScriptObjects liest den ScriptObjects-Chunk aus global.utoc.
func ReadScriptObjects(b []byte) (ScriptObjects, error) {
	names, p, err := ReadNameBatch(b, 0)
	if err != nil {
		return nil, err
	}
	le := binary.LittleEndian
	n := int(le.Uint32(b[p:]))
	p += 4
	so := ScriptObjects{}
	for i := 0; i < n; i++ {
		ni := le.Uint32(b[p:])
		idx := le.Uint64(b[p+8:])
		if int(ni&0x3fffffff) < len(names) {
			so[idx] = names[ni&0x3fffffff]
		}
		p += 32
	}
	return so, nil
}

type Export struct {
	Name       string
	PublicHash uint64
	ClassIndex uint64
	Class      string
	OuterIndex uint64
	Offset     int // Position im Chunk
	Size       int
}

type Package struct {
	ID           uint64   // Paket-ID (vom Aufrufer gesetzt)
	Path         string   // Dateipfad (vom Aufrufer gesetzt)
	ExportHashes []uint64 // ImportedPublicExportHashes
	Data         []byte
	Names        []string
	Imports      []uint64
	Exports      []Export
}

const indexNull = 0xffffffffffffffff

// Parse liest den Paketkopf; Klassen werden über die ScriptObjects aufgelöst.
func Parse(b []byte, so ScriptObjects) (*Package, error) {
	le := binary.LittleEndian
	if len(b) < 44 {
		return nil, fmt.Errorf("zen: zu kurz")
	}
	if le.Uint32(b[0:]) != 0 {
		return nil, fmt.Errorf("zen: Versionsinfo nicht unterstützt")
	}
	headerSize := int(le.Uint32(b[4:]))
	cookedHeaderSize := int(le.Uint32(b[20:]))
	hashesOff := int(le.Uint32(b[24:]))
	importMapOff := int(le.Uint32(b[28:]))
	exportMapOff := int(le.Uint32(b[32:]))
	bundleOff := int(le.Uint32(b[36:]))
	graphOff := int(le.Uint32(b[40:]))
	names, _, err := ReadNameBatch(b, 44)
	if err != nil {
		return nil, err
	}
	pk := &Package{Data: b, Names: names}
	for p := hashesOff; p < importMapOff; p += 8 {
		pk.ExportHashes = append(pk.ExportHashes, le.Uint64(b[p:]))
	}
	for p := importMapOff; p < exportMapOff; p += 8 {
		pk.Imports = append(pk.Imports, le.Uint64(b[p:]))
	}
	_ = cookedHeaderSize
	for p := exportMapOff; p+72 <= bundleOff; p += 72 {
		e := Export{
			Offset:     -1,
			Size:       int(le.Uint64(b[p+8:])),
			Name:       pk.name(le.Uint32(b[p+16:]), le.Uint32(b[p+20:])),
			OuterIndex: le.Uint64(b[p+24:]),
			ClassIndex: le.Uint64(b[p+32:]),
			PublicHash: le.Uint64(b[p+56:]),
		}
		pk.Exports = append(pk.Exports, e)
	}
	for i := range pk.Exports {
		pk.Exports[i].Class = pk.resolve(pk.Exports[i].ClassIndex, so)
	}
	// Exportdaten liegen ab HeaderSize hintereinander, in der Reihenfolge
	// der Serialize-Befehle des Export-Bundles.
	pos := headerSize
	for p := bundleOff; p+8 <= graphOff; p += 8 {
		idx, cmd := int(le.Uint32(b[p:])), le.Uint32(b[p+4:])
		if cmd != 1 || idx >= len(pk.Exports) {
			continue
		}
		pk.Exports[idx].Offset = pos
		pos += pk.Exports[idx].Size
	}
	if pos > len(b) {
		return nil, fmt.Errorf("zen: Exportdaten (%d) länger als Chunk (%d)", pos, len(b))
	}
	return pk, nil
}

func (pk *Package) name(i, num uint32) string {
	i &= 0x3fffffff
	if int(i) >= len(pk.Names) {
		return fmt.Sprintf("?name%d", i)
	}
	if num > 0 {
		return fmt.Sprintf("%s_%d", pk.Names[i], num-1)
	}
	return pk.Names[i]
}

func (pk *Package) resolve(idx uint64, so ScriptObjects) string {
	if idx == indexNull {
		return ""
	}
	switch idx >> 62 {
	case 0:
		n := int(idx & (1<<62 - 1))
		if n < len(pk.Exports) {
			return pk.Exports[n].Name
		}
		return fmt.Sprintf("export%d", n)
	case 1:
		if s, ok := so[idx]; ok {
			return s
		}
	}
	return fmt.Sprintf("%016x", idx)
}

// ---- getaggte Properties ----

type Property struct {
	Name     string
	Type     string
	Struct   string // bei StructProperty
	Inner    string // bei Array/Set/Map
	Value    string // bei Map
	Bool     bool
	Raw      []byte // Wertbytes
	ArrayIdx int
}

type Reader struct {
	pk *Package
	B  []byte
	P  int
}

func (pk *Package) Reader(e Export) *Reader {
	if e.Offset < 0 {
		return &Reader{pk: pk}
	}
	return &Reader{pk: pk, B: pk.Data[e.Offset : e.Offset+e.Size]}
}

func (r *Reader) U8() byte     { v := r.B[r.P]; r.P++; return v }
func (r *Reader) U32() uint32  { v := binary.LittleEndian.Uint32(r.B[r.P:]); r.P += 4; return v }
func (r *Reader) I32() int32   { return int32(r.U32()) }
func (r *Reader) U64() uint64  { v := binary.LittleEndian.Uint64(r.B[r.P:]); r.P += 8; return v }
func (r *Reader) F32() float32 { return math.Float32frombits(r.U32()) }
func (r *Reader) F64() float64 { return math.Float64frombits(r.U64()) }
func (r *Reader) Name() string { i := r.U32(); n := r.U32(); return r.pk.name(i, n) }

// Properties liest getaggte Properties bis "None".
func (r *Reader) Properties() ([]Property, error) {
	var props []Property
	for {
		if r.P+8 > len(r.B) {
			return props, fmt.Errorf("props: Ende erreicht")
		}
		name := r.Name()
		if name == "None" {
			return props, nil
		}
		if r.P+16 > len(r.B) {
			return props, fmt.Errorf("props: %s abgeschnitten", name)
		}
		pr := Property{Name: name, Type: r.Name()}
		size := int(r.I32())
		pr.ArrayIdx = int(r.I32())
		if r.P+9 > len(r.B) {
			return props, fmt.Errorf("props: %s abgeschnitten", name)
		}
		switch pr.Type {
		case "StructProperty":
			pr.Struct = r.Name()
			r.P += 16
		case "BoolProperty":
			pr.Bool = r.U8() != 0
		case "ByteProperty", "EnumProperty":
			pr.Inner = r.Name()
		case "ArrayProperty", "SetProperty", "OptionalProperty":
			pr.Inner = r.Name()
		case "MapProperty":
			pr.Inner = r.Name()
			pr.Value = r.Name()
		}
		if r.U8() != 0 {
			r.P += 16
		}
		if size < 0 || r.P+size > len(r.B) {
			return props, fmt.Errorf("props: %s ungültige Größe %d", name, size)
		}
		pr.Raw = r.B[r.P : r.P+size]
		r.P += size
		props = append(props, pr)
	}
}

// Helfer zur Wertinterpretation.

func (pr Property) Int() int64 {
	switch len(pr.Raw) {
	case 1:
		return int64(pr.Raw[0])
	case 4:
		return int64(int32(binary.LittleEndian.Uint32(pr.Raw)))
	case 8:
		return int64(binary.LittleEndian.Uint64(pr.Raw))
	}
	return 0
}

func (pr Property) Float() float64 {
	switch len(pr.Raw) {
	case 4:
		return float64(math.Float32frombits(binary.LittleEndian.Uint32(pr.Raw)))
	case 8:
		return math.Float64frombits(binary.LittleEndian.Uint64(pr.Raw))
	}
	return 0
}

// Vec liest ein FVector (UE5: 3×double, bei 12 Byte 3×float).
func (pr Property) Vec() [3]float64 {
	var v [3]float64
	le := binary.LittleEndian
	if len(pr.Raw) >= 24 {
		for i := range v {
			v[i] = math.Float64frombits(le.Uint64(pr.Raw[8*i:]))
		}
	} else if len(pr.Raw) >= 12 {
		for i := range v {
			v[i] = float64(math.Float32frombits(le.Uint32(pr.Raw[4*i:])))
		}
	}
	return v
}

// ObjectIndex liefert den FPackageIndex einer ObjectProperty.
func (pr Property) ObjectIndex() int32 {
	if len(pr.Raw) < 4 {
		return 0
	}
	return int32(binary.LittleEndian.Uint32(pr.Raw))
}

func Find(props []Property, name string) (Property, bool) {
	for _, p := range props {
		if p.Name == name {
			return p, true
		}
	}
	return Property{}, false
}

// Row ist eine Zeile einer DataTable.
type Row struct {
	Name  string
	Props []Property
}

// DataTableRows liest die nativen Zeilen einer DataTable (nach deren Properties):
// uint32 GUID-Flag des Objekts, int32 Anzahl, je Zeile FName + getaggte Properties.
func (r *Reader) DataTableRows() ([]Row, error) {
	if r.P+8 > len(r.B) {
		return nil, fmt.Errorf("datatable: zu kurz")
	}
	if r.U32() != 0 {
		r.P += 16 // Objekt-GUID
	}
	n := int(r.I32())
	rows := make([]Row, 0, n)
	for i := 0; i < n; i++ {
		name := r.Name()
		props, err := r.Properties()
		if err != nil {
			return rows, fmt.Errorf("zeile %s: %w", name, err)
		}
		rows = append(rows, Row{name, props})
	}
	return rows, nil
}

// Sub liefert einen Reader über rohe Wertbytes desselben Pakets.
func (pk *Package) Sub(b []byte) *Reader { return &Reader{pk: pk, B: b} }

// Struct liest eine StructProperty mit getaggtem Inhalt (keine native Struktur).
func (pk *Package) Struct(pr Property) []Property {
	props, _ := pk.Sub(pr.Raw).Properties()
	return props
}

// StructArray zerlegt eine ArrayProperty mit StructProperty-Elementen. Getaggte
// Strukturen liefern Properties, native (Vector, Quat …) nur rohe Elementbytes.
func (pk *Package) StructArray(pr Property) (structName string, tagged [][]Property, raw [][]byte) {
	if pr.Type != "ArrayProperty" || pr.Inner != "StructProperty" || len(pr.Raw) < 4 {
		return "", nil, nil
	}
	r := pk.Sub(pr.Raw)
	n := int(r.I32())
	if n == 0 || r.P+8*2+8 > len(r.B) {
		return "", nil, nil
	}
	r.Name() // Name des inneren Tags
	r.Name() // "StructProperty"
	size := int(r.I32())
	r.I32() // ArrayIndex
	structName = r.Name()
	r.P += 16 // StructGuid
	if r.U8() != 0 {
		r.P += 16
	}
	switch structName {
	case "Vector", "Vector3d", "Rotator", "Quat", "Vector2D", "Vector4", "Guid", "IntPoint", "Color", "LinearColor", "Box":
		es := size / n
		for i := 0; i < n && r.P+es <= len(r.B); i++ {
			raw = append(raw, r.B[r.P:r.P+es])
			r.P += es
		}
		return structName, nil, raw
	}
	for i := 0; i < n; i++ {
		props, err := r.Properties()
		if err != nil {
			break
		}
		tagged = append(tagged, props)
	}
	return structName, tagged, nil
}

// SoftPath liest eine SoftObjectProperty (FTopLevelAssetPath + SubPath) als Paketpfad.
func (pk *Package) SoftPath(pr Property) string {
	if pr.Type != "SoftObjectProperty" || len(pr.Raw) < 8 {
		return ""
	}
	r := pk.Sub(pr.Raw)
	return r.Name()
}
