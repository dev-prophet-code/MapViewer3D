package layout

import "testing"

// Eine Kachel der Vorlage (Bounds ab (0, -2032) m) landet mit ihrer Ecke auf der Zelle.
func TestShift(t *testing.T) {
	tile := Tile{GX: 2, GY: 8, Bounds: [6]float64{0, -203200, 0, 101600, -101600, 0}}
	o := [2]float64{-1000, -2000}
	sh := tile.Shift(o)
	if got, want := tile.Bounds[0]+sh[0], o[0]+2*TileSize; got != want {
		t.Errorf("x: Ecke bei %v, erwartet %v", got, want)
	}
	if got, want := tile.Bounds[1]+sh[1], o[1]+8*TileSize; got != want {
		t.Errorf("y: Ecke bei %v, erwartet %v", got, want)
	}
}
