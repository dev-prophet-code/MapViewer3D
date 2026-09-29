//go:build paks

package server

import (
	"fmt"
	"os"
	"path/filepath"

	"mapviewer3d/assets"
	"mapviewer3d/mapbuild"
	"mapviewer3d/maps"
)

// AutoBuildAvailable: dieses Programm kann Gelände aus den Spieldateien bauen.
const AutoBuildAvailable = true

func (s *Server) buildLayout(n int, dir string) error {
	db, err := assets.Open(s.paks)
	if err != nil {
		return err
	}
	defs, _ := maps.Resolve([]string{"DeepDesert_1"}, db.Paths())
	if len(defs) == 0 || defs[0].Repeat == "" {
		return fmt.Errorf("Deep Desert nicht in den Spieldateien gefunden")
	}
	def := defs[0]
	def.Layout = n
	def.ID = filepath.Base(dir)
	res, err := mapbuild.Build(db, def)
	if err != nil {
		return err
	}
	tmp := dir + ".tmp"
	os.RemoveAll(tmp)
	if err := res.Write(tmp); err != nil {
		os.RemoveAll(tmp)
		return err
	}
	os.RemoveAll(dir)
	return os.Rename(tmp, dir)
}
