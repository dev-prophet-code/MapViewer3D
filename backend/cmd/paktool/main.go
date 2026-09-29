// paktool untersucht die IoStore-Container der Serverpaks.
//
//	go run ./cmd/paktool <paks> ls [Filter]                 Dateien auflisten
//	go run ./cmd/paktool <paks> cat <Pfadendung> > datei     Paketdaten roh ausgeben
//	go run ./cmd/paktool <paks> inspect <Pfadendung> [Export] Exporte und Properties
package main

import (
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"os"
	"sort"
	"strings"

	"mapviewer3d/assets"
	"mapviewer3d/zen"
)

func main() {
	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, "Aufruf: paktool <paks> ls|cat|inspect [Argumente]")
		os.Exit(2)
	}
	db, err := assets.Open(os.Args[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	args := os.Args[3:]
	switch os.Args[2] {
	case "ls":
		list(db, args)
	case "cat":
		cat(db, args)
	case "inspect":
		if len(args) == 0 {
			fmt.Fprintln(os.Stderr, "inspect braucht eine Pfadendung")
			os.Exit(2)
		}
		inspect(db, args)
	default:
		fmt.Fprintln(os.Stderr, "unbekannter Befehl", os.Args[2])
		os.Exit(2)
	}
}

func list(db *assets.DB, args []string) {
	var names []string
	for p, r := range db.Store.Files {
		if len(args) == 0 || strings.Contains(strings.ToLower(p), strings.ToLower(args[0])) {
			names = append(names, fmt.Sprintf("%s\t%s\t%d", p, r.C.Name, r.C.Size(r.C.ChunkIDOf(r.Index))))
		}
	}
	sort.Strings(names)
	for _, n := range names {
		fmt.Println(n)
	}
	fmt.Fprintln(os.Stderr, len(names), "Dateien")
}

func cat(db *assets.DB, args []string) {
	for p, r := range db.Store.Files {
		if len(args) > 0 && strings.HasSuffix(p, args[0]) {
			b, err := r.C.ReadIndex(r.Index)
			if err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
			fmt.Fprintln(os.Stderr, p, len(b))
			os.Stdout.Write(b)
			return
		}
	}
	fmt.Fprintln(os.Stderr, "nicht gefunden")
	os.Exit(1)
}

func inspect(db *assets.DB, args []string) {
	filter := ""
	if len(args) > 1 {
		filter = args[1]
	}
	for _, name := range db.Paths() {
		if !strings.HasSuffix(name, strings.TrimSuffix(strings.TrimSuffix(args[0], ".uasset"), ".umap")) {
			continue
		}
		pk, err := db.LoadPath(name)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			continue
		}
		fmt.Println(name, len(pk.Data), "Bytes,", len(pk.Exports), "Exporte")
		for i, e := range pk.Exports {
			if filter != "" && !strings.Contains(e.Name, filter) && !strings.Contains(db.ClassName(pk, e), filter) {
				continue
			}
			fmt.Printf("[%d] %s (%s) @%d +%d outer=%x\n", i, e.Name, db.ClassName(pk, e), e.Offset, e.Size, e.OuterIndex)
			r := pk.Reader(e)
			if r.B == nil {
				continue
			}
			props, err := r.Properties()
			for _, pr := range props {
				fmt.Printf("    %s: %s %s%s = %s\n", pr.Name, pr.Type, pr.Struct, pr.Inner, show(db, pk, pr))
			}
			if err != nil {
				fmt.Println("    FEHLER:", err)
			}
			fmt.Printf("    Rest nach Properties: %d Bytes\n", len(r.B)-r.P)
		}
	}
}

func show(db *assets.DB, pk *zen.Package, pr zen.Property) string {
	le := binary.LittleEndian
	ref := func(i int32) string {
		r, err := db.Resolve(pk, i)
		if err != nil {
			return fmt.Sprintf("?%d(%v)", i, err)
		}
		if r.Pkg != nil && r.Pkg != pk {
			return r.Pkg.Path + ":" + r.Name
		}
		return r.Name
	}
	switch {
	case pr.Type == "ObjectProperty" && len(pr.Raw) == 4:
		return ref(pr.ObjectIndex())
	case pr.Type == "ArrayProperty" && pr.Inner == "ObjectProperty" && len(pr.Raw) >= 4:
		n := int(le.Uint32(pr.Raw))
		var parts []string
		for k := 0; k < n && k < 12; k++ {
			parts = append(parts, ref(int32(le.Uint32(pr.Raw[4+4*k:]))))
		}
		if n > 12 {
			parts = append(parts, fmt.Sprintf("… (%d)", n))
		}
		return "[" + strings.Join(parts, ", ") + "]"
	case pr.Type == "SoftObjectProperty" && len(pr.Raw) >= 16:
		return pk.Names[le.Uint32(pr.Raw)&0x3fffffff] + "." + pk.Names[le.Uint32(pr.Raw[8:])&0x3fffffff]
	case pr.Type == "IntProperty" || pr.Type == "FloatProperty" || pr.Type == "DoubleProperty":
		if pr.Type == "IntProperty" {
			return fmt.Sprint(pr.Int())
		}
		return fmt.Sprint(pr.Float())
	case pr.Struct == "Vector" || pr.Struct == "Rotator":
		return fmt.Sprint(pr.Vec())
	case pr.Type == "NameProperty" && len(pr.Raw) == 8:
		return pk.Names[le.Uint32(pr.Raw)&0x3fffffff]
	}
	v := hex.EncodeToString(pr.Raw)
	if len(v) > 64 {
		v = v[:64] + "…"
	}
	return v
}
