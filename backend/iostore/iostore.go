// Package iostore liest Unreal-Engine-5-IoStore-Container (.utoc/.ucas),
// wie sie im Dune-Awakening-Serverimage liegen: unverschlüsselt, Oodle-komprimiert.
package iostore

import (
	"encoding/binary"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"mapviewer3d/oodle"
)

// Chunk-Typen (EIoChunkType, UE5).
const (
	ChunkExportBundleData  = 1
	ChunkBulkData          = 2
	ChunkOptionalBulkData  = 3
	ChunkMemoryMappedBulk  = 4
	ChunkScriptObjects     = 5
	ChunkContainerHeader   = 6
	ChunkShaderCodeLibrary = 8
	ChunkPackageStoreEntry = 10
)

type ChunkID struct {
	ID    uint64
	Index uint16
	Type  uint8
}

func (c ChunkID) String() string { return fmt.Sprintf("%016x-%d-%d", c.ID, c.Index, c.Type) }

type block struct {
	offset     uint64
	compSize   uint32
	uncompSize uint32
	method     uint8
}

// Container ist ein geöffnetes .utoc/.ucas-Paar.
type Container struct {
	Name        string
	ucas        *os.File
	ucasPath    string
	blockSize   uint64
	methods     []string
	chunks      []ChunkID
	offsets     []uint64
	lengths     []uint64
	blocks      []block
	byID        map[ChunkID]int
	Files       map[string]int // Pfad -> Chunk-Index
	MountPoint  string
	ContainerID uint64
	mu          sync.Mutex
}

func u40be(b []byte) uint64 {
	return uint64(b[0])<<32 | uint64(b[1])<<24 | uint64(b[2])<<16 | uint64(b[3])<<8 | uint64(b[4])
}

// Open liest die .utoc; die .ucas daneben wird für Chunk-Zugriffe geöffnet.
func Open(utocPath string) (*Container, error) {
	d, err := os.ReadFile(utocPath)
	if err != nil {
		return nil, err
	}
	if string(d[:16]) != "-==--==--==--==-" {
		return nil, fmt.Errorf("%s: keine utoc", utocPath)
	}
	le := binary.LittleEndian
	version := d[16]
	hdrSize := le.Uint32(d[20:])
	entryCount := int(le.Uint32(d[24:]))
	blockCount := int(le.Uint32(d[28:]))
	blockEntrySize := int(le.Uint32(d[32:]))
	methodCount := int(le.Uint32(d[36:]))
	methodLen := int(le.Uint32(d[40:]))
	blockSize := le.Uint32(d[44:])
	dirIndexSize := int(le.Uint32(d[48:]))
	flags := d[80]
	seedsCount := int(le.Uint32(d[84:]))
	noHashCount := int(le.Uint32(d[96:]))
	if version < 4 {
		seedsCount, noHashCount = 0, 0
	}
	if flags&2 != 0 {
		return nil, fmt.Errorf("%s: verschlüsselt", utocPath)
	}
	c := &Container{
		Name:      strings.TrimSuffix(filepath.Base(utocPath), ".utoc"),
		blockSize: uint64(blockSize),
		byID:      make(map[ChunkID]int, entryCount),
		Files:     map[string]int{},
	}
	c.ContainerID = le.Uint64(d[0x38:])
	p := int(hdrSize)
	for i := 0; i < entryCount; i++ {
		id := ChunkID{ID: le.Uint64(d[p:]), Index: le.Uint16(d[p+8:]), Type: d[p+11]}
		c.chunks = append(c.chunks, id)
		c.byID[id] = i
		p += 12
	}
	for i := 0; i < entryCount; i++ {
		c.offsets = append(c.offsets, u40be(d[p:]))
		c.lengths = append(c.lengths, u40be(d[p+5:]))
		p += 10
	}
	p += seedsCount*4 + noHashCount*4
	for i := 0; i < blockCount; i++ {
		b := d[p : p+blockEntrySize]
		c.blocks = append(c.blocks, block{
			offset:     le.Uint64(append(append([]byte{}, b[:5]...), 0, 0, 0)),
			compSize:   le.Uint32(b[4:]) >> 8,
			uncompSize: le.Uint32(b[8:]) & 0xffffff,
			method:     b[11],
		})
		p += blockEntrySize
	}
	for i := 0; i < methodCount; i++ {
		c.methods = append(c.methods, strings.TrimRight(string(d[p:p+methodLen]), "\x00"))
		p += methodLen
	}
	if flags&4 != 0 { // signiert
		hs := int(le.Uint32(d[p:]))
		p += 4 + 2*hs + 20*blockCount
	}
	if flags&8 != 0 && dirIndexSize > 0 {
		c.readDirectoryIndex(d[p : p+dirIndexSize])
	}
	c.ucasPath = strings.TrimSuffix(utocPath, ".utoc") + ".ucas"
	return c, nil
}

type reader struct {
	b []byte
	p int
}

func (r *reader) u32() uint32 { v := binary.LittleEndian.Uint32(r.b[r.p:]); r.p += 4; return v }
func (r *reader) fstring() string {
	n := int(int32(r.u32()))
	if n == 0 {
		return ""
	}
	if n < 0 { // UTF-16
		n = -n
		s := make([]rune, 0, n)
		for i := 0; i < n; i++ {
			s = append(s, rune(binary.LittleEndian.Uint16(r.b[r.p+2*i:])))
		}
		r.p += 2 * n
		return strings.TrimRight(string(s), "\x00")
	}
	s := string(r.b[r.p : r.p+n-1])
	r.p += n
	return s
}

func (c *Container) readDirectoryIndex(b []byte) {
	r := &reader{b: b}
	c.MountPoint = r.fstring()
	type dirEntry struct{ name, firstChild, nextSibling, firstFile uint32 }
	type fileEntry struct{ name, next, user uint32 }
	nd := int(r.u32())
	dirs := make([]dirEntry, nd)
	for i := range dirs {
		dirs[i] = dirEntry{r.u32(), r.u32(), r.u32(), r.u32()}
	}
	nf := int(r.u32())
	files := make([]fileEntry, nf)
	for i := range files {
		files[i] = fileEntry{r.u32(), r.u32(), r.u32()}
	}
	ns := int(r.u32())
	strs := make([]string, ns)
	for i := range strs {
		strs[i] = r.fstring()
	}
	const none = 0xffffffff
	name := func(i uint32) string {
		if i == none {
			return ""
		}
		return strs[i]
	}
	var walk func(di uint32, prefix string)
	walk = func(di uint32, prefix string) {
		for di != none {
			d := dirs[di]
			path := prefix
			if n := name(d.name); n != "" {
				path = prefix + n + "/"
			}
			for fi := d.firstFile; fi != none; fi = files[fi].next {
				c.Files[path+name(files[fi].name)] = int(files[fi].user)
			}
			walk(d.firstChild, path)
			di = d.nextSibling
		}
	}
	if nd > 0 {
		walk(0, c.MountPoint)
	}
}

// Chunks liefert alle Chunk-IDs.
func (c *Container) Chunks() []ChunkID { return c.chunks }

// Has meldet, ob der Container den Chunk enthält.
func (c *Container) Has(id ChunkID) bool { _, ok := c.byID[id]; return ok }

// ChunkIDOf liefert die Chunk-ID eines Indexeintrags.
func (c *Container) ChunkIDOf(i int) ChunkID { return c.chunks[i] }

// Read liest einen Chunk vollständig und entpackt ihn.
func (c *Container) Read(id ChunkID) ([]byte, error) {
	i, ok := c.byID[id]
	if !ok {
		return nil, fmt.Errorf("chunk %s nicht in %s", id, c.Name)
	}
	return c.ReadIndex(i)
}

// ReadIndex liest den i-ten Chunk.
func (c *Container) ReadIndex(i int) ([]byte, error) {
	off, length := c.offsets[i], c.lengths[i]
	out := make([]byte, 0, length)
	first := off / c.blockSize
	last := (off + length - 1) / c.blockSize
	if length == 0 {
		return out, nil
	}
	for bi := first; bi <= last; bi++ {
		blk := c.blocks[bi]
		raw := make([]byte, blk.compSize)
		c.mu.Lock()
		if c.ucas == nil {
			f, err := os.Open(c.ucasPath)
			if err != nil {
				c.mu.Unlock()
				return nil, err
			}
			c.ucas = f
		}
		_, err := c.ucas.ReadAt(raw, int64(blk.offset))
		c.mu.Unlock()
		if err != nil {
			return nil, err
		}
		var data []byte
		if blk.method == 0 {
			data = raw[:blk.uncompSize]
		} else {
			m := c.methods[blk.method-1]
			if m != "Oodle" {
				return nil, fmt.Errorf("Kompression %q nicht unterstützt", m)
			}
			data, err = oodle.Decompress(raw, int(blk.uncompSize))
			if err != nil {
				return nil, fmt.Errorf("block %d: %w", bi, err)
			}
		}
		start := uint64(0)
		if bi == first {
			start = off % c.blockSize
		}
		end := uint64(len(data))
		if rem := off + length - bi*c.blockSize; rem < end {
			end = rem
		}
		out = append(out, data[start:end]...)
	}
	return out, nil
}

// Size liefert die entpackte Länge des Chunks.
func (c *Container) Size(id ChunkID) uint64 { return c.lengths[c.byID[id]] }

// Store bündelt alle Container eines Paks-Verzeichnisses.
type Store struct {
	Containers []*Container
	Files      map[string]FileRef
}

type FileRef struct {
	C     *Container
	Index int
}

func OpenDir(dir string) (*Store, error) {
	matches, _ := filepath.Glob(filepath.Join(dir, "*.utoc"))
	sort.Strings(matches)
	s := &Store{Files: map[string]FileRef{}}
	for _, m := range matches {
		c, err := Open(m)
		if err != nil {
			return nil, err
		}
		s.Containers = append(s.Containers, c)
		for p, i := range c.Files {
			s.Files[p] = FileRef{c, i}
		}
	}
	return s, nil
}

// Read sucht den Chunk in allen Containern.
func (s *Store) Read(id ChunkID) ([]byte, error) {
	for _, c := range s.Containers {
		if c.Has(id) {
			return c.Read(id)
		}
	}
	return nil, fmt.Errorf("chunk %s nicht gefunden", id)
}

func (s *Store) Has(id ChunkID) bool {
	for _, c := range s.Containers {
		if c.Has(id) {
			return true
		}
	}
	return false
}
