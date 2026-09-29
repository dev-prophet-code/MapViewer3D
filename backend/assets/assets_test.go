package assets

import (
	"encoding/binary"
	"testing"
)

// header baut einen gültigen Container-Header V2 mit einem Paket und einem Import.
func header() []byte {
	le := binary.LittleEndian
	b := make([]byte, 20+8+4+24+8)
	le.PutUint32(b[16:], 1)        // 1 Paket
	le.PutUint64(b[20:], 0xAAAA)   // Paket-ID
	e := 20 + 8 + 4                // StoreEntry
	le.PutUint32(b[e+8:], 1)       // 1 Import
	le.PutUint32(b[e+12:], 24-8)   // Offset relativ zu e+8 → direkt hinter dem Entry
	le.PutUint64(b[e+24:], 0xBBBB) // Import-ID
	return b
}

func TestParseContainerHeaderValid(t *testing.T) {
	db := &DB{pkgs: map[uint64]*pkgInfo{0xAAAA: {}}}
	if err := db.parseContainerHeader(1, header()); err != nil {
		t.Fatal(err)
	}
	if got := db.pkgs[0xAAAA].imported; len(got) != 1 || got[0] != 0xBBBB {
		t.Fatalf("imported = %v", got)
	}
}

// Jede Kürzung und ein absurder Zähler müssen einen Fehler liefern, nie eine Panik.
func TestParseContainerHeaderTruncated(t *testing.T) {
	full := header()
	for n := 0; n < len(full); n++ {
		db := &DB{pkgs: map[uint64]*pkgInfo{0xAAAA: {}}}
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("Länge %d: Panik %v", n, r)
				}
			}()
			_ = db.parseContainerHeader(1, full[:n])
		}()
	}
	huge := header()
	binary.LittleEndian.PutUint32(huge[16:], 0xFFFFFFF0)
	db := &DB{pkgs: map[uint64]*pkgInfo{0xAAAA: {}}}
	if err := db.parseContainerHeader(1, huge); err == nil {
		t.Error("absurder Paketzähler wurde akzeptiert")
	}
}
