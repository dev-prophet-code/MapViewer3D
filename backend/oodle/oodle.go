// Package oodle bindet den Open-Source-Dekompressor "ooz" (Kraken, Mermaid,
// Selkie, Leviathan) per cgo ein. Die Quellen liegen im selben Verzeichnis.
package oodle

/*
#cgo CXXFLAGS: -std=c++17 -O2 -DOOZ_BUILD_DLL=1 -I${SRCDIR}/simde -w
#include <stdint.h>
#include <stddef.h>
int Ooz_Decompress(uint8_t const* src_buf, int src_len, uint8_t* dst, size_t dst_size,
        int, int, int, uint8_t*, size_t, void*, void*, void*, size_t, int);
*/
import "C"

import (
	"fmt"
	"unsafe"
)

// safeSpace: ooz schreibt bis zu 64 Byte über das Zielende hinaus.
const safeSpace = 64

// Decompress entpackt src in genau size Bytes.
func Decompress(src []byte, size int) ([]byte, error) {
	if len(src) == 0 {
		return nil, fmt.Errorf("oodle: leere Eingabe")
	}
	buf := make([]byte, size+safeSpace)
	n := C.Ooz_Decompress((*C.uint8_t)(unsafe.Pointer(&src[0])), C.int(len(src)),
		(*C.uint8_t)(unsafe.Pointer(&buf[0])), C.size_t(size),
		0, 0, 0, nil, 0, nil, nil, nil, 0, 0)
	if int(n) != size {
		return nil, fmt.Errorf("oodle: %d statt %d Bytes entpackt", int(n), size)
	}
	return buf[:size], nil
}
