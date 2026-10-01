//go:build windows

package updater

import (
	"log"
	"os"
	"os/exec"
)

// RestartSelf startet das (neue) Programm exe mit denselben Argumenten und beendet
// diesen Prozess. beforeExec gibt z. B. den Port frei.
func RestartSelf(exe string, beforeExec func()) {
	if beforeExec != nil {
		beforeExec()
	}
	os.Setenv("MV_RESTARTED", "1")
	cmd := exec.Command(exe, os.Args[1:]...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := cmd.Start(); err != nil {
		log.Printf("Neustart fehlgeschlagen: %v – bitte das Programm selbst neu starten", err)
		return
	}
	os.Exit(0)
}
