package mesh

import (
	"bufio"
	"encoding/binary"
	"math"
	"os"
)

// WriteDML schreibt ein Netz kompakt (little-endian), gelesen von viewer/js/meshes.js:
//
//	"DML1", u32 nv, u32 ni, f32 lo[3], f32 hi[3],
//	u16 pos[3·nv] (auf lo…hi quantisiert), Auffüllen auf 4 Byte,
//	idx[ni] als u16 (nv ≤ 65535) oder u32
func WriteDML(file string, m Mesh) error {
	f, err := os.Create(file)
	if err != nil {
		return err
	}
	defer f.Close()
	w := bufio.NewWriter(f)
	le := binary.LittleEndian
	lo, hi := m.Bounds()
	nv := len(m.Pos) / 3
	w.WriteString("DML1")
	binary.Write(w, le, uint32(nv))
	binary.Write(w, le, uint32(len(m.Idx)))
	binary.Write(w, le, lo)
	binary.Write(w, le, hi)
	q := make([]uint16, len(m.Pos))
	for v := 0; v < nv; v++ {
		for k := 0; k < 3; k++ {
			if span := hi[k] - lo[k]; span > 0 {
				q[3*v+k] = uint16(math.Round(float64((m.Pos[3*v+k] - lo[k]) / span * 65535)))
			}
		}
	}
	binary.Write(w, le, q)
	if (6*nv)%4 != 0 {
		w.Write([]byte{0, 0})
	}
	if nv <= 65535 {
		i16 := make([]uint16, len(m.Idx))
		for i, v := range m.Idx {
			i16[i] = uint16(v)
		}
		binary.Write(w, le, i16)
	} else {
		binary.Write(w, le, m.Idx)
	}
	return w.Flush()
}
