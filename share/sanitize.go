package main

import (
	"bytes"
	"encoding/json"
	"regexp"
	"strings"
)

// Everything a visitor receives passes through here. The Console's answers carry more than the map
// needs (account and Funcom ids, storage contents, server settings); an allow list per route keeps
// only what the viewer draws, so a new field in a later Console version stays private by default.

type obj = map[string]any

func decode(body []byte) (obj, error) {
	d := json.NewDecoder(bytes.NewReader(body))
	d.UseNumber() // keep every number exactly as the Console wrote it
	var v obj
	if err := d.Decode(&v); err != nil {
		return nil, err
	}
	return v, nil
}

func keep(src obj, keys ...string) obj {
	out := obj{}
	for _, k := range keys {
		if v, ok := src[k]; ok {
			out[k] = v
		}
	}
	return out
}

// marker rows (/api/map/overlays, players, poi, spice)
var rowKeys = []string{"id", "type", "name", "subtype", "subtypeLabel", "class", "map", "partition_id", "x", "y", "z",
	"base_type", "marker_type", "item_count", "group"}

func cleanRow(r obj, o linkOptions) (obj, bool) {
	typ, _ := r["type"].(string)
	if typ == "player" && !o.Players {
		return nil, false
	}
	out := keep(r, rowKeys...)
	for k, v := range r {
		if strings.HasPrefix(k, "sector") { // grid cell of the Deep Desert
			out[k] = v
		}
	}
	if typ == "player" {
		out["online_status"] = r["online_status"]
	}
	if o.Players { // names of owners are players' names
		if v, ok := r["owner_name"]; ok {
			out["owner_name"] = v
		}
	}
	return out, true
}

func sanitizeRows(body []byte, o linkOptions) ([]byte, error) {
	v, err := decode(body)
	if err != nil {
		return nil, err
	}
	rows, _ := v["rows"].([]any)
	out := make([]any, 0, len(rows))
	for _, r := range rows {
		if m, ok := r.(obj); ok {
			if c, ok := cleanRow(m, o); ok {
				out = append(out, c)
			}
		}
	}
	return json.Marshal(obj{"rows": out})
}

// /api/map/markers: the viewer reads the map image + calibration and the Coriolis cycle.
func sanitizeMarkers(body []byte) ([]byte, error) {
	v, err := decode(body)
	if err != nil {
		return nil, err
	}
	out := keep(v, "coriolisLayout", "coriolisSeed", "coriolisNextCycleAt")
	if maps, ok := v["maps"].(obj); ok {
		cm := obj{}
		for name, m := range maps {
			if mm, ok := m.(obj); ok {
				cm[name] = keep(mm, "image", "minX", "maxX", "minY", "maxY", "flipY")
			}
		}
		out["maps"] = cm
	}
	return json.Marshal(out)
}

func sanitizePartitions(body []byte) ([]byte, error) {
	v, err := decode(body)
	if err != nil {
		return nil, err
	}
	rows, _ := v["rows"].([]any)
	out := make([]any, 0, len(rows))
	for _, r := range rows {
		if m, ok := r.(obj); ok {
			out = append(out, keep(m, "map", "alive", "partition_id", "name"))
		}
	}
	return json.Marshal(obj{"rows": out})
}

func sanitizeStatus(body []byte) ([]byte, error) {
	v, err := decode(body)
	if err != nil {
		return nil, err
	}
	out := obj{}
	if m, ok := v["maps"].(obj); ok {
		out["maps"] = keep(m, "stdout")
	}
	return json.Marshal(out)
}

// The values endpoint returns whole setting files. The viewer reads two lines; nothing else is passed
// on (the file can contain passwords).
func sanitizeSettings(body []byte) ([]byte, error) {
	v, err := decode(body)
	if err != nil {
		return nil, err
	}
	stdout, _ := v["stdout"].(string)
	var keepLines []string
	for _, l := range strings.Split(stdout, "\n") {
		if strings.HasPrefix(l, "server_display_name\t") || strings.HasPrefix(l, "partition_pvp_enabled\t") {
			keepLines = append(keepLines, strings.TrimRight(l, "\r"))
		}
	}
	return json.Marshal(obj{"stdout": strings.Join(keepLines, "\n")})
}

// /api/bases/<id>/export is a blueprint: the pieces and their places, plus (for placeables) their
// contents. Only geometry survives.
func sanitizeBase(body []byte) ([]byte, error) {
	v, err := decode(body)
	if err != nil {
		return nil, err
	}
	out := keep(v, "x", "y", "z")
	for _, key := range []string{"instances", "placeables"} {
		list, _ := v[key].([]any)
		cleaned := make([]any, 0, len(list))
		for _, p := range list {
			if m, ok := p.(obj); ok {
				cleaned = append(cleaned, keep(m, "building_type", "x", "y", "z", "rotation", "rx", "ry", "rz"))
			}
		}
		out[key] = cleaned
	}
	return json.Marshal(out)
}

func sanitizeRealtimeHealth(body []byte) ([]byte, error) {
	v, err := decode(body)
	if err != nil {
		return nil, err
	}
	return json.Marshal(obj{"available": v["available"] == true})
}

// The snapshot route (polling fallback of the viewer): the same content as a stream snapshot, players removed.
func sanitizeRealtimeObjects(body []byte) ([]byte, error) {
	v, err := decode(body)
	if err != nil {
		return nil, err
	}
	dropPlayers(v, map[string]bool{})
	return json.Marshal(keep(v, "gen", "t", "sources", "objects"))
}

// dropPlayers removes player objects from a realtime snapshot and returns their ids.
func dropPlayers(snap obj, dropped map[string]bool) {
	list, _ := snap["objects"].([]any)
	kept := make([]any, 0, len(list))
	for _, o := range list {
		m, ok := o.(obj)
		if !ok {
			continue
		}
		if k, _ := m["k"].(string); k == "player" {
			dropped[idKey(m["i"])] = true
			continue
		}
		kept = append(kept, m)
	}
	snap["objects"] = kept
}

func idKey(v any) string {
	switch t := v.(type) {
	case json.Number:
		return t.String()
	case string:
		return t
	}
	return ""
}

var (
	settingScope = regexp.MustCompile(`^(partitionEngine|partition)$`)
	mapName      = regexp.MustCompile(`^[A-Za-z0-9_]{1,64}$`)
	digits       = regexp.MustCompile(`^[0-9]{1,12}$`)
	imageName    = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,100}\.(png|webp|jpg|jpeg|svg)$`)
)
