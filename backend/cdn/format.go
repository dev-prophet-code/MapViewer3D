// Package cdn liest und schreibt die Kartendaten des Branches `cdn` im Repository:
// Gelände-Kacheln (128+1)², von Inhalts-Hashes benannt, ein Index je Karte und ein
// Katalog mit den Prüfsummen. Der Viewer streamt die Karten von dort (Client); der
// Sync-Dienst auf dem Server hält den Branch aktuell (Pack). Das Format ist das des
// Addons (tools/tilepack.mjs im Branch DD-Addon).
package cdn

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"io"
)

const (
	Format     = 1
	PatchQuads = 128
	N          = PatchQuads + 1 // Stützpunkte je Kachelkante
	maxTileRaw = 3 * N * N
)

// EncodeTile packt Höhen (N*N, uint16) und Materialien (N*N) im Kachelformat 1:
// Höhen zeilenweise delta-codiert (mod 65536), getrennt in Low- und High-Byte-Ebene,
// danach die Materialbytes.
func EncodeTile(heights []uint16, mats []byte) []byte {
	out := make([]byte, 3*N*N)
	lo, hi, mt := 0, N*N, 2*N*N
	for j := 0; j < N; j++ {
		var prev uint16
		for i := 0; i < N; i++ {
			v := heights[j*N+i]
			d := v - prev // mod 65536
			prev = v
			out[lo+j*N+i] = byte(d)
			out[hi+j*N+i] = byte(d >> 8)
		}
	}
	copy(out[mt:], mats)
	return out
}

// TileID ist die Kennung einer Kachel: die ersten 16 Hex-Stellen des SHA-256 des Rohinhalts.
func TileID(raw []byte) string {
	h := sha256.Sum256(raw)
	return hex.EncodeToString(h[:])[:16]
}

// Gzip komprimiert mit der stärksten Stufe.
func Gzip(raw []byte) []byte {
	var b bytes.Buffer
	zw, _ := gzip.NewWriterLevel(&b, gzip.BestCompression)
	zw.Write(raw)
	zw.Close()
	return b.Bytes()
}

// Unpack entpackt eine .z-Datei zum Rohinhalt der Kachel.
func Unpack(z []byte) ([]byte, error) {
	zr, err := gzip.NewReader(bytes.NewReader(z))
	if err != nil {
		return nil, err
	}
	defer zr.Close()
	raw, err := io.ReadAll(io.LimitReader(zr, maxTileRaw+1))
	if err != nil {
		return nil, err
	}
	if len(raw) != maxTileRaw {
		return nil, errors.New("Kachel hat unerwartete Größe")
	}
	return raw, nil
}

// Patch wandelt den Rohinhalt in das Format von /api/map/<karte>/patch um:
// N*N Höhen (uint16 LE), danach N*N Materialbytes.
func Patch(raw []byte) []byte {
	out := make([]byte, 3*N*N)
	lo, hi, mt := 0, N*N, 2*N*N
	for j := 0; j < N; j++ {
		var v uint16
		for i := 0; i < N; i++ {
			v += uint16(raw[lo+j*N+i]) | uint16(raw[hi+j*N+i])<<8
			binary.LittleEndian.PutUint16(out[2*(j*N+i):], v)
		}
	}
	copy(out[2*N*N:], raw[mt:mt+N*N])
	return out
}
