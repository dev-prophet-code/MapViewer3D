// Package ue enthält Transformationen im Unreal-Koordinatensystem.
package ue

import (
	"math"

	"mapviewer3d/zen"
)

// Mat ist eine affine 4×4-Matrix für Spaltenvektoren (M[zeile][spalte]).
type Mat [4][4]float64

func Identity() Mat {
	return Mat{{1, 0, 0, 0}, {0, 1, 0, 0}, {0, 0, 1, 0}, {0, 0, 0, 1}}
}

// FromTRS baut Translation·Rotation·Skalierung wie FTransform.
// rot = (Pitch, Yaw, Roll) in Grad, wie FRotator serialisiert wird.
func FromTRS(loc, rot, scale [3]float64) Mat {
	d := math.Pi / 180
	sp, cp := math.Sincos(rot[0] * d)
	sy, cy := math.Sincos(rot[1] * d)
	sr, cr := math.Sincos(rot[2] * d)
	// Zeilen von FRotationMatrix = Bilder der Achsen X, Y, Z
	ax := [3]float64{cp * cy, cp * sy, sp}
	ay := [3]float64{sr*sp*cy - cr*sy, sr*sp*sy + cr*cy, -sr * cp}
	az := [3]float64{-(cr*sp*cy + sr*sy), cy*sr - cr*sp*sy, cr * cp}
	var m Mat
	for r := 0; r < 3; r++ {
		m[r][0] = ax[r] * scale[0]
		m[r][1] = ay[r] * scale[1]
		m[r][2] = az[r] * scale[2]
		m[r][3] = loc[r]
	}
	m[3][3] = 1
	return m
}

func (a Mat) Mul(b Mat) Mat {
	var m Mat
	for r := 0; r < 4; r++ {
		for c := 0; c < 4; c++ {
			for k := 0; k < 4; k++ {
				m[r][c] += a[r][k] * b[k][c]
			}
		}
	}
	return m
}

func (a Mat) Apply(v [3]float64) [3]float64 {
	var o [3]float64
	for r := 0; r < 3; r++ {
		o[r] = a[r][0]*v[0] + a[r][1]*v[1] + a[r][2]*v[2] + a[r][3]
	}
	return o
}

// ToThree bildet Unreal-Welt (cm, X/Y/Z) auf three.js (m, X/Z/Y) ab.
func ToThree() Mat {
	return Mat{{0.01, 0, 0, 0}, {0, 0, 0.01, 0}, {0, 0.01, 0, 0}, {0, 0, 0, 1}}
}

// Relative liest RelativeLocation/Rotation/Scale3D aus Properties.
func Relative(props []zen.Property) Mat {
	loc := [3]float64{}
	rot := [3]float64{}
	scale := [3]float64{1, 1, 1}
	if p, ok := zen.Find(props, "RelativeLocation"); ok {
		loc = p.Vec()
	}
	if p, ok := zen.Find(props, "RelativeRotation"); ok {
		rot = p.Vec()
	}
	if p, ok := zen.Find(props, "RelativeScale3D"); ok {
		scale = p.Vec()
	}
	return FromTRS(loc, rot, scale)
}

// FromQuatTRS baut Translation·Rotation(Quaternion x,y,z,w)·Skalierung.
func FromQuatTRS(q [4]float64, loc, scale [3]float64) Mat {
	x, y, z, w := q[0], q[1], q[2], q[3]
	r := [3][3]float64{
		{1 - 2*(y*y+z*z), 2 * (x*y - z*w), 2 * (x*z + y*w)},
		{2 * (x*y + z*w), 1 - 2*(x*x+z*z), 2 * (y*z - x*w)},
		{2 * (x*z - y*w), 2 * (y*z + x*w), 1 - 2*(x*x+y*y)},
	}
	var m Mat
	for i := 0; i < 3; i++ {
		for j := 0; j < 3; j++ {
			m[i][j] = r[i][j] * scale[j]
		}
		m[i][3] = loc[i]
	}
	m[3][3] = 1
	return m
}
