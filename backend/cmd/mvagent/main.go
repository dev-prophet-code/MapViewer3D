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
	"runtime"
	"strconv"
	"syscall"
	"time"

	"mapviewer3d/agent"
	"mapviewer3d/server"
)

func main() {
	cfg := agent.Config{}
	addr := flag.String("addr", "127.0.0.1:8796", "Adresse für die lokale Schnittstelle")
	allowOpen := flag.Bool("allow-open", false, "Adresse außerhalb von Loopback erlauben (die Schnittstelle hat keinen Login!)")
	flag.StringVar(&cfg.ProcRoot, "proc", "/proc", "Prozessverzeichnis des Hosts")
	flag.Float64Var(&cfg.Hz, "hz", 10, "Abtastrate der aktiven Objekte (Quelle liefert höchstens ~20 Hz)")
	flag.IntVar(&cfg.Workers, "workers", 4, "parallele Scan-Worker")
	flag.DurationVar(&cfg.Rescan, "rescan", 5*time.Minute, "volle Discovery in diesem Abstand (neue Objekte erscheinen dann)")
	flag.DurationVar(&cfg.RescanMin, "rescan-min", 30*time.Second, "frühestens so oft auf Anforderung (verschwundener Wurm/Fahrzeug) neu suchen")
	flag.DurationVar(&cfg.Supervise, "supervise", 15*time.Second, "Intervall der Prozesserkennung")
	flag.BoolVar(&cfg.Players, "players", false, "auch Spieler ausgeben (Standard aus: Datenschutz)")
	flag.IntVar(&cfg.OnlyPID, "pid", 0, "nur diesen Prozess (Diagnose)")
	blocks := flag.String("blocks", "", "FNamePool-Offset (Standard 0x174125A8, Build 2134304)")
	root := flag.String("root", "", "Offset von AActor::RootComponent (Standard 0x238)")
	pos := flag.String("pos", "", "Offset der Weltposition im RootComponent (Standard 0x190)")
	once := flag.Bool("once", false, "einmal suchen, Ergebnis als JSON ausgeben und beenden")
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
	if err := srv.Serve(ln); err != nil && ctx.Err() == nil {
		log.Fatal(err)
	}
}
