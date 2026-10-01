package agent

import (
	"encoding/binary"
	"fmt"
	"sync"
	"unicode/utf16"
)

// Mem ist ein lesbarer Prozessspeicher (/proc/<pid>/mem oder, in Tests, ein Nachbau).
type Mem interface {
	ReadAt(p []byte, off int64) (int, error)
}

// Pool liest Namen aus dem FNamePool der Unreal Engine (UE 5, Stride 2).
//
//	Block  = index >> 16
//	Offset = (index & 0xFFFF) * 2
//	Header (uint16): Bit 0 = UTF-16, Bits 6..15 = Länge; die Zeichen folgen direkt.
//	FName mit Nummer N > 0 wird zu "<Name>_<N-1>".
type Pool struct {
	mem    Mem
	blocks uint64 // Adresse von Blocks[0] (Zeigerfeld im .bss der Binary)

	mu    sync.Mutex
	ptrs  map[uint32]uint64
	names map[uint32]string
}

func NewPool(mem Mem, blocksAddr uint64) *Pool {
	return &Pool{mem: mem, blocks: blocksAddr, ptrs: map[uint32]uint64{}, names: map[uint32]string{}}
}

func (p *Pool) block(i uint32) (uint64, bool) {
	if v, ok := p.ptrs[i]; ok {
		return v, v != 0
	}
	var b [8]byte
	if n, _ := p.mem.ReadAt(b[:], int64(p.blocks)+8*int64(i)); n != 8 {
		return 0, false
	}
	v := binary.LittleEndian.Uint64(b[:])
	if v != 0 && !plausiblePtr(v) {
		v = 0
	}
	p.ptrs[i] = v
	return v, v != 0
}

// Name löst einen FName auf. Gibt false zurück, wenn der Eintrag nicht lesbar
// oder offensichtlich Müll ist (z. B. Pool noch nicht gefüllt).
func (p *Pool) Name(index, number uint32) (string, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	s, ok := p.names[index]
	if !ok {
		blk, good := p.block(index >> 16)
		if !good {
			return "", false
		}
		addr := int64(blk) + int64(index&0xFFFF)*2
		var h [2]byte
		if n, _ := p.mem.ReadAt(h[:], addr); n != 2 {
			return "", false
		}
		hdr := binary.LittleEndian.Uint16(h[:])
		wide := hdr&1 != 0
		ln := int(hdr >> 6)
		if ln == 0 || ln > 512 {
			return "", false
		}
		size := ln
		if wide {
			size = 2 * ln
		}
		buf := make([]byte, size)
		if n, _ := p.mem.ReadAt(buf, addr+2); n != size {
			return "", false
		}
		if wide {
			u := make([]uint16, ln)
			for i := range u {
				u[i] = binary.LittleEndian.Uint16(buf[2*i:])
			}
			s = string(utf16.Decode(u))
		} else {
			for _, c := range buf {
				if c < 0x20 || c > 0x7e {
					return "", false
				}
			}
			s = string(buf)
		}
		p.names[index] = s
	}
	if number > 0 {
		return fmt.Sprintf("%s_%d", s, number-1), true
	}
	return s, true
}

// Check ist der Selbsttest: Index 0 muss "None", Index 3 "ByteProperty" ergeben.
func (p *Pool) Check() bool {
	a, ok1 := p.Name(0, 0)
	b, ok2 := p.Name(3, 0)
	return ok1 && ok2 && a == "None" && b == "ByteProperty"
}

// plausiblePtr: Benutzeradresse eines 64-Bit-Prozesses (x86-64/arm64 Linux).
func plausiblePtr(v uint64) bool { return v >= 0x10000 && v < 0x0000_8000_0000_0000 && v&7 == 0 }

// poolSignature: Block 0 beginnt immer mit den Namen "None" und "ByteProperty".
var poolSignature = append(append([]byte{0x1E, 0x01}, "None"...), append([]byte{0x10, 0x03}, "ByteProperty"...)...)
