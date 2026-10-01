package agent

import (
	"debug/elf"
	"fmt"
	"strconv"
)

// Klassen, deren Objekte gesucht werden, und wie sie in der Ausgabe heißen.
var classKinds = map[string]string{
	"ADuneNpcCharacter":         "npc",      // Gegner, Gestrandete, Soldaten
	"ADuneNpcCharacterCivilian": "civilian", // Zivilisten, Händler, Quartiermeister
	"ATaxationNpc":              "civilian", // Steuer-NPC
	"ASandwormPawn":             "worm",
	"ADuneVehicle":              "vehicle",
	"ADuneOrnithopter":          "vehicle",
	"AWheeledVehiclePawn":       "vehicle",
	"ADunePlayerCharacter":      "player",
	"ASandStormBase":            "storm",    // Sandsturm (Actor entsteht nur, solange ein Sturm läuft)
	"ACoriolisBase":             "coriolis", // Coriolis-Sturm
}

// classCoriolisSub ist das Subsystem mit dem Coriolis-Zeitplan (kein Actor, keine Position).
const classCoriolisSub = "UCoriolisSubsystem"

// weatherKind: Arten, die der schnelle Sturm-Scan sucht.
func isStorm(kind string) bool { return kind == "storm" || kind == "coriolis" }

// vtableAddrs liest die Vtable-Symbole (_ZTV<Länge><Klasse>) der gesuchten
// Klassen aus der dynamischen Symboltabelle der Binary: Klasse → Symboladresse.
// Zur Laufzeit zeigt der Objektzeiger auf Modulbasis + Symboladresse + 0x10.
func vtableAddrs(path string) (map[string]uint64, error) {
	f, err := elf.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	syms, err := f.DynamicSymbols()
	if err != nil {
		return nil, fmt.Errorf("dynsym: %w", err)
	}
	out := map[string]uint64{}
	for _, s := range syms {
		if s.Value == 0 {
			continue
		}
		if cls, ok := demangleVtable(s.Name); ok {
			if _, want := classKinds[cls]; want || cls == classCoriolisSub {
				out[cls] = s.Value
			}
		}
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("keine Vtable-Symbole der gesuchten Klassen in %s", path)
	}
	return out, nil
}

// demangleVtable zerlegt _ZTV17ADuneNpcCharacter in "ADuneNpcCharacter".
// Verschachtelte Namen (_ZTVN…) und Vorlagen interessieren nicht.
func demangleVtable(sym string) (string, bool) {
	const pre = "_ZTV"
	if len(sym) <= len(pre) || sym[:len(pre)] != pre {
		return "", false
	}
	rest := sym[len(pre):]
	i := 0
	for i < len(rest) && rest[i] >= '0' && rest[i] <= '9' {
		i++
	}
	if i == 0 || i > 3 {
		return "", false
	}
	n, err := strconv.Atoi(rest[:i])
	if err != nil || n != len(rest)-i {
		return "", false
	}
	return rest[i:], true
}
