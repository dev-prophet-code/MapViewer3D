//go:build !paks

package server

import "errors"

// AutoBuildAvailable: Die fertigen Programme sind reines Go und lesen die Spieldateien
// nicht (der Leser braucht C++ für die Oodle-Entpackung). Mit `go build -tags paks`
// entsteht ein Programm, das das Gelände neuer Coriolis-Layouts selbst baut.
const AutoBuildAvailable = false

func (s *Server) buildLayout(n int, dir string) error {
	return errors.New("dieses Programm wurde ohne Spieldatei-Unterstützung gebaut (go build -tags paks)")
}
