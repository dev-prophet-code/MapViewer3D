//go:build !windows

package updater

import (
	"log"
	"os"
	"syscall"
)

// RestartSelf ersetzt den laufenden Prozess durch das (neue) Programm exe mit denselben
// Argumenten; auch unter systemd bleibt dabei die PID erhalten. beforeExec gibt z. B.
// den Port frei. Kehrt nur bei einem Fehler zurück.
func RestartSelf(exe string, beforeExec func()) {
	if beforeExec != nil {
		beforeExec()
	}
	os.Setenv("MV_RESTARTED", "1")
	err := syscall.Exec(exe, os.Args, os.Environ())
	log.Printf("Neustart fehlgeschlagen: %v – bitte das Programm selbst neu starten", err)
}
