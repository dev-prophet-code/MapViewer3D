package zen

import (
	"encoding/binary"
	"math/rand"
	"testing"
)

// Namenstabelle für die Testdaten
const (
	nNone = iota
	nFoo
	nStruct
	nVector
	nBool
	nMap
	nKey
	nVal
	nArray
)

var testNames = []string{"None", "Foo", "StructProperty", "Vector", "BoolProperty", "MapProperty", "Key", "Val", "ArrayProperty"}

type buf []byte

func (b *buf) name(i int) {
	*b = binary.LittleEndian.AppendUint32(*b, uint32(i))
	*b = binary.LittleEndian.AppendUint32(*b, 0)
}
func (b *buf) i32(v int32) { *b = binary.LittleEndian.AppendUint32(*b, uint32(v)) }
func (b *buf) raw(n int)   { *b = append(*b, make([]byte, n)...) }

func pkg() *Package { return &Package{Names: testNames} }

// prop erzeugt eine getaggte Property des Typs typ mit size Byte Wert, gefolgt von "None".
func prop(typ, size int) []byte {
	var b buf
	b.name(nFoo)
	b.name(typ)
	b.i32(int32(size))
	b.i32(0)
	switch typ {
	case nStruct:
		b.name(nVector)
		b.raw(16)
	case nMap:
		b.name(nKey)
		b.name(nVal)
	case nBool:
		b = append(b, 1)
	case nArray:
		b.name(nStruct)
	}
	b = append(b, 0) // keine Property-Guid
	if typ != nBool {
		b.raw(size)
	}
	b.name(nNone)
	return b
}

// sizeFor: BoolProperty trägt seinen Wert im Tag (Größe 0), alle anderen 24 Byte
func sizeFor(typ int) int {
	if typ == nBool {
		return 0
	}
	return 24
}

func TestPropertiesValid(t *testing.T) {
	for _, typ := range []int{nStruct, nMap, nBool, nArray} {
		props, err := pkg().Sub(prop(typ, sizeFor(typ))).Properties()
		if err != nil || len(props) != 1 || props[0].Name != "Foo" {
			t.Errorf("Typ %s: props=%v err=%v", testNames[typ], props, err)
		}
	}
}

// Jede Kürzung gültiger Daten muss einen Fehler liefern, nie eine Panik.
func TestPropertiesTruncatedNeverPanics(t *testing.T) {
	for _, typ := range []int{nStruct, nMap, nBool, nArray} {
		full := prop(typ, sizeFor(typ))
		for n := 0; n < len(full); n++ {
			func() {
				defer func() {
					if r := recover(); r != nil {
						t.Errorf("Typ %s, Länge %d: Panik %v", testNames[typ], n, r)
					}
				}()
				pkg().Sub(full[:n]).Properties()
			}()
		}
	}
}

func TestPropertiesRandomNeverPanics(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	for i := 0; i < 20000; i++ {
		b := make([]byte, rng.Intn(120))
		rng.Read(b)
		// häufige Typnamen erzwingen, damit die Zweige erreicht werden
		if len(b) >= 16 {
			binary.LittleEndian.PutUint32(b[8:], uint32(nStruct+rng.Intn(4)))
			binary.LittleEndian.PutUint32(b[12:], 0)
			binary.LittleEndian.PutUint32(b[16-16:], uint32(nFoo))
		}
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("Zufallsdaten %x: Panik %v", b, r)
				}
			}()
			pkg().Sub(b).Properties()
		}()
	}
}

func TestStructArrayTruncatedNeverPanics(t *testing.T) {
	var b buf
	b.i32(2) // 2 Elemente
	b.name(nFoo)
	b.name(nStruct)
	b.i32(48)
	b.i32(0)
	b.name(nVector)
	b.raw(16)
	b = append(b, 0)
	b.raw(48)
	full := []byte(b)
	for n := 0; n <= len(full); n++ {
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("Länge %d: Panik %v", n, r)
				}
			}()
			pr := Property{Type: "ArrayProperty", Inner: "StructProperty", Raw: full[:n]}
			pkg().StructArray(pr)
		}()
	}
	name, _, raw := pkg().StructArray(Property{Type: "ArrayProperty", Inner: "StructProperty", Raw: full})
	if name != "Vector" || len(raw) != 2 {
		t.Errorf("gültige Daten: name=%q raw=%d", name, len(raw))
	}
}
