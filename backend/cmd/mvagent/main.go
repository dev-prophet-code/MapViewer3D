// mvagent liest NPC-, Feind-, Sandwurm- und Fahrzeugpositionen aus dem Speicher
// der Dune-Awakening-Map-Server und stellt sie lokal bereit. Der Viewer
// (mapviewer -agent http://127.0.0.1:8796) zeigt sie live auf der Karte.
//
//	sudo mvagent                          # lauscht auf 127.0.0.1:8796
//	sudo mvagent -once                    # Diagnose: einmal suchen, JSON ausgeben
//	sudo mvagent -hz 15 -rescan 2m
//
// Nur lesend (/proc/<pid>/mem), kein ptrace, kein Eingriff in das Spiel. Braucht
// root auf dem Host (nicht im Container) und die Offsets des laufenden Builds
// (Standard: 2134304, bei einem Update bestimmt der Agent sie selbst neu).
// Nur auf eigenen Servern einsetzen.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"syscall"
	"time"

	"mapviewer3d/agent"
	"mapviewer3d/server"
	"mapviewer3d/updater"
)

func main() {
	cfg := agent.Config{}
	addr := flag.String("addr", "127.0.0.1:8796", "Adresse für die lokale Schnittstelle")
	allowOpen := flag.Bool("allow-open", false, "Adresse außerhalb von Loopback erlauben (die Schnittstelle hat keinen Login!)")
	flag.StringVar(&cfg.ProcRoot, "proc", "/proc", "Prozessverzeichnis des Hosts")
	flag.Float64Var(&cfg.Hz, "hz", 10, "Abtastrate der aktiven Objekte (Quelle liefert höchstens ~20 Hz)")
	flag.IntVar(&cfg.Workers, "workers", 4, "parallele Scan-Worker")
	flag.DurationVar(&cfg.Rescan, "rescan", 30*time.Minute, "volle Discovery in diesem Abstand (neue Objekte erscheinen dann)")
	flag.DurationVar(&cfg.RescanMin, "rescan-min", time.Minute, "frühestens so oft auf Anforderung (verschwundener Wurm) neu suchen")
	flag.DurationVar(&cfg.Supervise, "supervise", 15*time.Second, "Intervall der Prozesserkennung")
	flag.BoolVar(&cfg.Players, "players", false, "auch Spieler ausgeben (Standard aus: Datenschutz)")
	flag.DurationVar(&cfg.StormScan, "storm-scan", 3*time.Minute, "kurze Suche nach Sandstürmen in diesem Abstand (negativ = aus)")
	flag.IntVar(&cfg.OnlyPID, "pid", 0, "nur diesen Prozess (Diagnose)")
	blocks := flag.String("blocks", "", "FNamePool-Offset (Standard 0x174125A8, Build 2134304)")
	root := flag.String("root", "", "Offset von AActor::RootComponent (Standard 0x238)")
	pos := flag.String("pos", "", "Offset der Weltposition im RootComponent (Standard 0x190)")
	probe := flag.String("probe", "", "Diagnose: Klassen nach Muster suchen (z. B. 'Storm|Coriolis'), Instanzen auflisten und Felder dumpen (mit -pid)")
	probeDump := flag.Int("probe-dump", 0x500, "Bytes pro Actor, die -probe auswertet (0 = nur auflisten)")
	once := flag.Bool("once", false, "einmal suchen, Ergebnis als JSON ausgeben und beenden")
	autoUpdate := flag.Bool("auto-update", os.Getenv("MV_AUTOUPDATE") == "1", "neue Versionen von GitHub automatisch installieren und neu starten (der Agent läuft als root: nur einschalten, wenn GitHub-Releases dieses Projekts vertraut wird; braucht Schreibrecht im Ordner des Programms)")
	version := flag.Bool("version", false, "Version anzeigen")
	flag.Parse()
	if *version {
		fmt.Println("Dune MapViewer3D Agent", server.Version)
		return
	}
	if runtime.GOOS != "linux" {
		log.Fatalf("mvagent liest /proc/<pid>/mem und läuft nur unter Linux (auf dem Spielserver, als root)")
	}
	cfg.Offsets = agent.DefaultOffsets
	for _, o := range []struct {
		s string
		p *uint64
	}{{*blocks, &cfg.Offsets.Blocks}, {*root, &cfg.Offsets.Root}, {*pos, &cfg.Offsets.Pos}} {
		if o.s == "" {
			continue
		}
		v, err := strconv.ParseUint(o.s, 0, 64)
		if err != nil {
			log.Fatalf("ungültiger Offset %q: %v", o.s, err)
		}
		*o.p = v
	}
	if os.Geteuid() != 0 {
		log.Printf("Achtung: kein root – /proc/<pid>/mem anderer Benutzer ist dann nicht lesbar")
	}
	if *probe != "" {
		if cfg.OnlyPID == 0 {
			log.Fatalf("-probe braucht -pid")
		}
		if err := agent.Probe(cfg.ProcRoot, cfg.OnlyPID, *probe, *probeDump, cfg.Offsets, os.Stdout); err != nil {
			log.Fatal(err)
		}
		return
	}
	a := agent.New(cfg)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if *once {
		snap := a.Discover(ctx)
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", " ")
		enc.Encode(snap)
		return
	}
	host, _, err := net.SplitHostPort(*addr)
	if err != nil {
		log.Fatalf("-addr: %v", err)
	}
	if ip := net.ParseIP(host); host != "localhost" && (ip == nil || !ip.IsLoopback()) && !*allowOpen {
		log.Fatalf("%s ist nicht lokal. Die Schnittstelle zeigt Positionen ohne Login; nur 127.0.0.1 verwenden (der Viewer holt die Daten dort ab) oder bewusst -allow-open angeben.", *addr)
	}
	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("Dune MapViewer3D Agent %s: http://%s (Offsets Blocks=0x%X Root=0x%X Pos=0x%X)", server.Version, ln.Addr(), cfg.Offsets.Blocks, cfg.Offsets.Root, cfg.Offsets.Pos)
	srv := &http.Server{Handler: a.Handler(), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		srv.Close()
	}()
	go a.Run(ctx)
	if *autoUpdate {
		startUpdater(ctx)
	}
	if err := srv.Serve(ln); err != nil && ctx.Err() == nil {
		log.Fatal(err)
	}
}

// startUpdater: der Agent ersetzt nur sich selbst (bin/mvagent-linux-<arch> aus dem Update-Paket)
// und startet sich neu; unter systemd bleibt dabei die PID erhalten.
func startUpdater(ctx context.Context) {
	exe, err := os.Executable()
	if err != nil {
		return
	}
	if r, err := filepath.EvalSymlinks(exe); err == nil {
		exe = r
	}
	if _, ok := updater.Number(server.Version); !ok {
		return
	}
	u := updater.New(updater.Config{
		Current: server.Version,
		Work:    filepath.Dir(exe),
		Auto:    true,
		Plan: func(stage string) ([]updater.Op, error) {
			src := filepath.Join(stage, "bin", "mvagent-linux-"+runtime.GOARCH)
			if _, err := os.Stat(src); err != nil {
				return nil, fmt.Errorf("Agent fehlt im Paket: %s", filepath.Base(src))
			}
			return []updater.Op{{Src: src, Dest: exe}}, nil
		},
		SelfTest: updater.VersionSelfTest("mvagent"),
		Restart: func() {
			updater.RestartSelf(exe, nil)
			log.Fatalf("Neustart nach dem Update fehlgeschlagen – systemd startet den Agenten neu")
		},
	})
	go u.Run(ctx)
	log.Printf("Automatische Updates von GitHub an (Prüfung alle %s)", updater.DefaultInterval)
}
