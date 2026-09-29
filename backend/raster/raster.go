// Package raster schreibt Dreiecke als Höhen-Maximum in ein reguläres Gitter.
package raster

import (
	"math"
	"runtime"
	"sync"
	"sync/atomic"

	"mapviewer3d/mesh"
	"mapviewer3d/ue"
)

// Grid: Stützpunkt (i,j) liegt bei Welt (OriginX + i·Spacing, OriginY + j·Spacing), cm.
type Grid struct {
	W, H             int
	OriginX, OriginY float64
	Spacing          float64
	bits             []uint32 // float32-Bits, -Inf = leer
}

var negInf = math.Float32bits(float32(math.Inf(-1)))

func New(w, h int, ox, oy, sp float64) *Grid {
	g := &Grid{W: w, H: h, OriginX: ox, OriginY: oy, Spacing: sp, bits: make([]uint32, w*h)}
	for i := range g.bits {
		g.bits[i] = negInf
	}
	return g
}

// At liefert die Höhe oder -Inf.
func (g *Grid) At(i int) float32 { return math.Float32frombits(atomic.LoadUint32(&g.bits[i])) }

func (g *Grid) max(i int, z float32) {
	p := &g.bits[i]
	nb := math.Float32bits(z)
	for {
		old := atomic.LoadUint32(p)
		if math.Float32frombits(old) >= z {
			return
		}
		if atomic.CompareAndSwapUint32(p, old, nb) {
			return
		}
	}
}

func (g *Grid) splat(x, y, z float64) {
	i := int(math.Round(x))
	j := int(math.Round(y))
	if i >= 0 && j >= 0 && i < g.W && j < g.H {
		g.max(j*g.W+i, float32(z))
	}
}

// Draw rastert alle Netze (parallel) mit ihren Welttransforms.
func (g *Grid) Draw(items []Item) {
	var wg sync.WaitGroup
	ch := make(chan Item)
	for w := 0; w < runtime.NumCPU(); w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for it := range ch {
				g.drawMesh(it.Mesh, it.M)
			}
		}()
	}
	for _, it := range items {
		ch <- it
	}
	close(ch)
	wg.Wait()
}

type Item struct {
	Mesh *mesh.Mesh
	M    ue.Mat
}

func (g *Grid) drawMesh(m *mesh.Mesh, M ue.Mat) {
	n := len(m.Pos) / 3
	// in Gitterkoordinaten transformieren
	gp := make([][3]float64, n)
	for v := 0; v < n; v++ {
		w := M.Apply([3]float64{float64(m.Pos[3*v]), float64(m.Pos[3*v+1]), float64(m.Pos[3*v+2])})
		gp[v] = [3]float64{(w[0] - g.OriginX) / g.Spacing, (w[1] - g.OriginY) / g.Spacing, w[2]}
	}
	for t := 0; t+2 < len(m.Idx); t += 3 {
		g.tri(gp[m.Idx[t]], gp[m.Idx[t+1]], gp[m.Idx[t+2]])
	}
}

func (g *Grid) tri(a, b, c [3]float64) {
	minX := math.Ceil(math.Min(a[0], math.Min(b[0], c[0])))
	maxX := math.Floor(math.Max(a[0], math.Max(b[0], c[0])))
	minY := math.Ceil(math.Min(a[1], math.Min(b[1], c[1])))
	maxY := math.Floor(math.Max(a[1], math.Max(b[1], c[1])))
	if maxX < 0 || maxY < 0 || minX >= float64(g.W) || minY >= float64(g.H) {
		// ganz außerhalb – Kanten könnten trotzdem hineinragen, aber nur knapp
		if maxX < -1 || maxY < -1 || minX > float64(g.W) || minY > float64(g.H) {
			return
		}
	}
	// Kanten abtasten: senkrechte Wände und schmale Dreiecke bleiben sichtbar
	for _, e := range [3][2][3]float64{{a, b}, {b, c}, {c, a}} {
		p, q := e[0], e[1]
		l := math.Hypot(q[0]-p[0], q[1]-p[1])
		steps := int(l*2) + 1
		for s := 0; s <= steps; s++ {
			t := float64(s) / float64(steps)
			g.splat(p[0]+(q[0]-p[0])*t, p[1]+(q[1]-p[1])*t, p[2]+(q[2]-p[2])*t)
		}
	}
	den := (b[1]-c[1])*(a[0]-c[0]) + (c[0]-b[0])*(a[1]-c[1])
	if math.Abs(den) < 1e-9 {
		return
	}
	minX = math.Max(minX, 0)
	minY = math.Max(minY, 0)
	maxX = math.Min(maxX, float64(g.W-1))
	maxY = math.Min(maxY, float64(g.H-1))
	for y := minY; y <= maxY; y++ {
		for x := minX; x <= maxX; x++ {
			l1 := ((b[1]-c[1])*(x-c[0]) + (c[0]-b[0])*(y-c[1])) / den
			l2 := ((c[1]-a[1])*(x-c[0]) + (a[0]-c[0])*(y-c[1])) / den
			l3 := 1 - l1 - l2
			if l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6 {
				continue
			}
			g.max(int(y)*g.W+int(x), float32(l1*a[2]+l2*b[2]+l3*c[2]))
		}
	}
}
