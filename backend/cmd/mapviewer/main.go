// mapviewer startet den Map Viewer (Weboberfläche + Karten-API + Live-Proxy).
//
//	mapviewer                         # Ordner data/ und viewer/ neben bin/
//	mapviewer -open                   # zusätzlich den Browser öffnen
//	mapviewer -addr 0.0.0.0:8795      # im Netz bzw. auf einem Server erreichbar
//	mapviewer -public public.json     # öffentlich: nur freigegebene PvE-Partitionen
//	mapviewer -config config.json     # Verbindung fest aus Datei statt Einrichtung im Browser
//	mapviewer -agent http://127.0.0.1:8796  # Sandwürmer, Gegner, Fahrzeuge live (Agent: cmd/mvagent)
//
// Beim ersten Start werden Server-Adresse und API-Token im Browser abgefragt und
// verschlüsselt gespeichert (Paket secure) – im Benutzerordner, nie im
// Projektordner. Der Projektordner bleibt so immer im Auslieferungszustand und
// kann weitergegeben werden, ohne Zugangsdaten mitzunehmen.
//
// Das Programm ist reines Go ohne cgo und wird für Windows, Linux und macOS
// vorgebaut (build-release.sh); zum Ausführen ist kein Go nötig.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"

	"mapviewer3d/secure"
	"mapviewer3d/server"
	"mapviewer3d/updater"
)

func main() {
	root := projectRoot()
	data := flag.String("data", filepath.Join(root, "data"), "Verzeichnis mit gebauten Karten")
	web := flag.String("web", filepath.Join(root, "viewer"), "Verzeichnis der Weboberfläche")
	state := flag.String("state", "", "Verzeichnis für Zugangsdaten, Instanznamen und Zwischenspeicher (Standard: Benutzer-Konfigordner/MapViewer3D)")
	keyDir := flag.String("keydir", "", "Ablage des Hauptschlüssels (Standard: Benutzer-Konfigordner)")
	addr := flag.String("addr", envOr("ADDR", "127.0.0.1:8795"), "Adresse; 0.0.0.0:8795 macht den Viewer im Netz erreichbar")
	password := flag.String("password", os.Getenv("MV_PASSWORD"), "Passwort für den Viewer (HTTP-Login, Benutzername egal); alternativ MV_PASSWORD oder viewerPassword in -config")
	allowOpen := flag.Bool("allow-open", false, "im Netz erreichbar OHNE Passwort erlauben (jeder mit der Adresse sieht Spielernamen und Positionen)")
	remoteSetup := flag.Bool("remote-setup", false, "Einrichtung auch von anderen Rechnern erlauben (nur hinter Zugangsschutz!)")
	noLocalAdmin := flag.Bool("no-local-admin", false, "Einrichtung im Browser nie zulassen, auch nicht vom Rechner selbst (z. B. hinter einem Reverse-Proxy; dann -config verwenden)")
	config := flag.String("config", "", "feste Konfigurationsdatei (apiBase, token, partitions, public) statt Einrichtung im Browser")
	public := flag.String("public", "", "öffentlicher Betrieb: JSON mit erlaubten Partitionen und PvE-Quelle (siehe server/public.go)")
	paks := flag.String("paks", "", "Ordner mit den Spieldateien (.utoc/.ucas): baut das Deep-Desert-Gelände nach jedem Coriolis-Sturm selbst für das neue Layout")
	agentURL := flag.String("agent", os.Getenv("MV_AGENT"), "Adresse des Positions-Agenten (mvagent), z. B. http://127.0.0.1:8796: zeigt Sandwürmer, Gegner und Fahrzeuge live; alternativ MV_AGENT oder agentUrl in -config")
	autoUpdate := flag.Bool("auto-update", os.Getenv("MV_AUTOUPDATE") == "1", "neue Versionen von GitHub automatisch installieren und neu starten (Standard: nur anzeigen, Installation per Klick); alternativ MV_AUTOUPDATE=1 oder autoUpdate in -config")
	noUpdate := flag.Bool("no-update-check", os.Getenv("MV_NO_UPDATE") == "1", "nicht auf GitHub nach neuen Versionen suchen (auch MV_NO_UPDATE=1)")
	// Ohne Argumente gestartet (Doppelklick im Explorer/Finder): Browser öffnen;
	// unter Windows zusätzlich das Fenster bei Fehlern offen halten.
	noArgs := len(os.Args) == 1 && os.Getenv("MV_RESTARTED") == ""
	doubleClick := runtime.GOOS == "windows" && noArgs
	open := flag.Bool("open", noArgs, "Browser nach dem Start öffnen")
	version := flag.Bool("version", false, "Version anzeigen")
	flag.Parse()
	pauseOnError = doubleClick
	if *version {
		fmt.Println("Dune MapViewer3D", server.Version)
		return
	}
	for _, d := range []string{*data, *web} {
		if _, err := os.Stat(d); err != nil {
			fatalf("Ordner fehlt: %s (Pfade mit -data/-web angeben)", d)
		}
	}
	if *state == "" {
		dir, err := userStateDir()
		if err != nil {
			fatalf("Benutzerordner nicht gefunden: %v (mit -state und -keydir angeben)", err)
		}
		*state = dir
	}
	if err := os.MkdirAll(*state, 0o700); err != nil {
		fatalf("Ordner %s: %v", *state, err)
	}
	cleanProject(root, *state)
	log.Printf("Einstellungen: %s", *state)
	var srv *server.Server
	if *config != "" {
		if insideDir(root, *config) {
			log.Printf("Achtung: %s liegt im Projektordner und enthält den Token im Klartext – außerhalb ablegen, sonst wird er mit weitergegeben", *config)
		}
		cfg, err := server.LoadLiveConfig(*config)
		if err != nil {
			fatalf("Konfiguration: %v", err)
		}
		srv = server.New(*data, *web, *state, nil)
		srv.UseConfig(cfg)
		if *password == "" {
			*password = cfg.ViewerPassword
		}
		if *agentURL == "" {
			*agentURL = cfg.AgentURL
		}
		if cfg.AutoUpdate {
			*autoUpdate = true
		}
		log.Printf("Verbindung aus %s", *config)
		if cfg.Public != nil {
			log.Printf("Öffentlicher Betrieb: nur Partitionen %v, soweit %s sie als PvE meldet", cfg.Public.Partitions, cfg.Public.ModeSource)
		}
	} else {
		store, err := secure.Open(filepath.Join(*state, "credentials.enc"), *keyDir)
		if err != nil {
			fatalf("Schlüsselablage: %v (auf Servern ohne Benutzerordner -keydir angeben)", err)
		}
		srv = server.New(*data, *web, *state, store)
	}
	srv.RemoteSetup = *remoteSetup
	srv.NoLocalAdmin = *noLocalAdmin
	if *public != "" {
		cfg, err := server.LoadPublicConfig(*public)
		if err != nil {
			fatalf("Öffentlicher Betrieb: %v", err)
		}
		srv.SetPublic(cfg)
		log.Printf("Öffentlicher Betrieb: nur Partitionen %v, soweit %s sie als PvE meldet", cfg.Partitions, cfg.ModeSource)
	}

	if *paks != "" {
		if _, err := os.Stat(*paks); err != nil {
			fatalf("Ordner fehlt: %s (-paks)", *paks)
		}
		if !server.AutoBuildAvailable {
			fatalf("-paks: Dieses Programm liest die Spieldateien nicht. Selbst bauen mit: cd backend && go build -tags paks -o ../bin/<Programm> ./cmd/mapviewer (braucht einen C++-Compiler)")
		}
		srv.EnableAutoLayout(*paks)
		log.Printf("Deep Desert: Gelände für neue Coriolis-Layouts wird aus %s selbst gebaut", *paks)
	}

	if *agentURL != "" {
		if err := srv.UseAgent(*agentURL); err != nil {
			fatalf("-agent: %v", err)
		}
		log.Printf("Live-Positionen (Würmer, Gegner, Fahrzeuge) vom Agenten %s", *agentURL)
	}

	var ln net.Listener
	var restarting atomic.Bool
	if !*noUpdate {
		startUpdater(srv, root, *autoUpdate, func() {
			restarting.Store(true) // http.Serve endet gleich; main soll dann nicht beenden
			if ln != nil {
				ln.Close()
			}
		})
	}

	srv.SetPassword(*password)
	if host, _, _ := net.SplitHostPort(*addr); !isLoopback(host) && !srv.HasPassword() && !*allowOpen {
		fatalf("%s ist im Netz erreichbar, aber ohne Passwort: das würde Spielernamen und Positionen für jeden mit der Adresse zeigen. Passwort setzen (-password, MV_PASSWORD oder viewerPassword in -config), nur lokal (127.0.0.1) starten oder bewusst -allow-open angeben.", *addr)
	}
	var err error
	ln, err = net.Listen("tcp", *addr)
	if err != nil {
		fatalf("%v", err)
	}
	url := "http://" + browserHost(ln.Addr().(*net.TCPAddr))
	log.Printf("Dune MapViewer3D %s (%s/%s): %s", server.Version, runtime.GOOS, runtime.GOARCH, url)
	if host, _, _ := net.SplitHostPort(*addr); !isLoopback(host) {
		if *remoteSetup {
			log.Printf("Im Netz erreichbar; Einrichtung von überall erlaubt (-remote-setup)")
		} else {
			log.Printf("Im Netz erreichbar; Einrichtung nur im Browser auf diesem Rechner")
		}
		if srv.HasPassword() {
			log.Printf("Zugriff nur mit Passwort (HTTP-Login)")
		} else if !srv.HasPublicFilter() {
			log.Printf("ACHTUNG: Der Viewer ist im Netz erreichbar und zeigt jedem mit der Adresse Spielernamen, Positionen, Basen und Fahrzeuge (Konten-Kennungen werden für Besucher entfernt). Nur in vertrauenswürdigen Netzen betreiben, per Firewall/Zugangsschutz absichern oder mit -public auf PvE-Partitionen beschränken.")
		}
	}
	if *open {
		go openBrowser(url)
	}
	err = http.Serve(ln, srv)
	if restarting.Load() {
		select {} // das Update startet das Programm gleich neu (startUpdater)
	}
	fatalf("%v", err)
}

// projectRoot ist der Ordner über bin/ (dort liegen data/, viewer/, state/).
// Liegt das Programm woanders (go run, eigener Pfad), gilt das Arbeitsverzeichnis
// bzw. dessen übergeordneter Ordner, je nachdem wo viewer/ zu finden ist.
func projectRoot() string {
	var candidates []string
	if exe, err := os.Executable(); err == nil {
		if exe, err = filepath.EvalSymlinks(exe); err == nil {
			dir := filepath.Dir(exe)
			candidates = append(candidates, filepath.Dir(dir), dir)
		}
	}
	if wd, err := os.Getwd(); err == nil {
		candidates = append(candidates, wd, filepath.Dir(wd))
	}
	for _, c := range candidates {
		if st, err := os.Stat(filepath.Join(c, "viewer", "index.html")); err == nil && !st.IsDir() {
			return c
		}
	}
	return "."
}

// pauseOnError hält das Fenster offen, wenn die .exe per Doppelklick lief –
// sonst schließt Windows es, bevor man die Fehlermeldung lesen kann.
var pauseOnError bool

func fatalf(format string, args ...any) {
	log.Printf(format, args...)
	if pauseOnError {
		fmt.Fprint(os.Stderr, "\nEnter drücken zum Schließen …")
		fmt.Fscanln(os.Stdin)
	}
	os.Exit(1)
}

// userStateDir: Einstellungen und Zugangsdaten gehören dem Benutzer, nicht dem
// Projektordner (Windows %AppData%, macOS ~/Library/Application Support,
// Linux ~/.config).
func userStateDir() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "MapViewer3D", "state"), nil
}

// cleanProject hält den Projektordner im Auslieferungszustand. Ältere Versionen
// legten Zugangsdaten, Instanznamen und Zwischenspeicher dort ab (state/,
// data/*/mapimage.png). Zugangsdaten und Namen ziehen in den Benutzerordner um,
// sofern dort noch keine liegen; alles andere wird gelöscht.
func cleanProject(root, state string) {
	old := filepath.Join(root, "state")
	if abs, _ := filepath.Abs(old); abs != "" {
		if st, _ := filepath.Abs(state); st == abs {
			log.Printf("Achtung: -state zeigt in den Projektordner – beim Weitergeben state/ entfernen")
			return
		}
	}
	for _, f := range []string{"credentials.enc", "instance-names.json"} {
		from, to := filepath.Join(old, f), filepath.Join(state, f)
		if _, err := os.Stat(from); err != nil {
			continue
		}
		if _, err := os.Stat(to); err == nil {
			continue
		}
		if err := moveFile(from, to); err == nil {
			log.Printf("%s aus dem Projektordner nach %s verschoben", f, state)
		}
	}
	if _, err := os.Stat(old); err == nil {
		if err := os.RemoveAll(old); err == nil {
			log.Printf("Projektordner bereinigt: state/ entfernt")
		}
	}
	matches, _ := filepath.Glob(filepath.Join(root, "data", "*", "mapimage.png"))
	for _, m := range matches {
		os.Remove(m)
	}
}

// insideDir: liegt path in dir (oder darunter)?
func insideDir(dir, path string) bool {
	d, err1 := filepath.Abs(dir)
	p, err2 := filepath.Abs(path)
	if err1 != nil || err2 != nil {
		return false
	}
	rel, err := filepath.Rel(d, p)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// moveFile verschiebt, notfalls per Kopie (anderes Laufwerk).
func moveFile(from, to string) error {
	if os.Rename(from, to) == nil {
		return nil
	}
	b, err := os.ReadFile(from)
	if err != nil {
		return err
	}
	if err := os.WriteFile(to, b, 0o600); err != nil {
		return err
	}
	return os.Remove(from)
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func isLoopback(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// browserHost: bei 0.0.0.0 bzw. :: öffnet der Browser die lokale Adresse.
func browserHost(a *net.TCPAddr) string {
	if a.IP == nil || a.IP.IsUnspecified() {
		return fmt.Sprintf("127.0.0.1:%d", a.Port)
	}
	return a.String()
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		if os.Getenv("DISPLAY") == "" && os.Getenv("WAYLAND_DISPLAY") == "" {
			return // Server ohne Bildschirm
		}
		cmd = exec.Command("xdg-open", url)
	}
	if err := cmd.Start(); err != nil {
		log.Printf("Browser öffnen: %v – bitte %s selbst aufrufen", err, url)
	}
}

// startUpdater richtet die Update-Prüfung ein (updater/). Download-Installationen zeigen
// ein Update an und installieren es auf Klick; mit -auto-update geschieht das von selbst.
// Ein Programm mit -tags paks (Server mit -paks) wird aus dem Quelltext des Pakets neu gebaut.
func startUpdater(srv *server.Server, root string, auto bool, closeListener func()) {
	exe, err := os.Executable()
	if err != nil {
		return
	}
	if r, err := filepath.EvalSymlinks(exe); err == nil {
		exe = r
	}
	if _, ok := updater.Number(server.Version); !ok {
		return // Entwicklungsstand ohne Versionsnummer
	}
	built := server.AutoBuildAvailable
	cfg := updater.Config{
		Current: server.Version,
		Work:    root,
		Auto:    auto,
		Plan:    updater.ViewerPlan(root, exe, built),
		Restart: func() {
			updater.RestartSelf(exe, closeListener)
			fatalf("Neustart nach dem Update fehlgeschlagen – bitte das Programm neu starten")
		},
	}
	if built {
		cfg.Prepare = updater.BuildPrepare(updater.FindGo(), filepath.Join(root, ".update"))
	}
	cfg.SelfTest = updater.VersionSelfTest("mapviewer")
	u := updater.New(cfg)
	srv.SetUpdater(u)
	go u.Run(context.Background())
	if auto {
		log.Printf("Automatische Updates von GitHub an (Prüfung alle %s)", updater.DefaultInterval)
	}
}
