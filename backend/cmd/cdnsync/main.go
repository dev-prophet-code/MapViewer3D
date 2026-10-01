// cdnsync hält den Branch `cdn` des Repositorys aktuell: Es schneidet extrahierte Karten
// (data/<karte>/…, data/buildables) in Kacheln (Paket cdn), schreibt sie in eine
// Arbeitskopie des Branches und überträgt Neues per git. Gedacht für einen Server, der die
// Spieldaten ohnehin hat (Zeitgesteuert, siehe docs/CDN-Sync-DE.md).
//
//	cdnsync -data /www/wwwroot/dune3d/data -repo /var/lib/mapviewer-cdn/repo \
//	        -state /var/lib/mapviewer-cdn/pack-state.json -push
//
// Kacheln heißen nach dem Hash ihres Inhalts und werden nie gelöscht; ohne Änderung
// entsteht kein Commit. Große Änderungen gehen in Paketen von höchstens -batch MB an
// GitHub, und catalog.json kommt zuletzt, damit er nie auf Fehlendes zeigt.
package main

import (
	"bytes"
	"flag"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"

	"mapviewer3d/cdn"
)

func main() {
	data := flag.String("data", "", "Ordner mit den extrahierten Karten (data/<karte>/, data/buildables)")
	repo := flag.String("repo", "", "Arbeitskopie des Branches cdn")
	cloneURL := flag.String("clone", "", "falls -repo noch nicht existiert: von dieser Adresse klonen (git@github.com:…/MapViewer3D.git)")
	branch := flag.String("branch", "cdn", "Branch")
	state := flag.String("state", "", "Datei, in der gemerkt wird, was schon gepackt ist (spart Zeit)")
	only := flag.String("maps", "", "nur diese Kartenordner (kommagetrennt)")
	push := flag.Bool("push", false, "Änderungen committen und zu GitHub übertragen (sonst nur packen)")
	batch := flag.Int("batch", 12, "höchste Größe eines Pakets beim Übertragen in MB")
	msg := flag.String("message", "Data update", "Commit-Nachricht (Präfix)")
	flag.Parse()
	if *data == "" || *repo == "" {
		flag.Usage()
		os.Exit(2)
	}
	if _, err := os.Stat(filepath.Join(*repo, ".git")); err != nil {
		if *cloneURL == "" {
			log.Fatalf("%s ist keine Arbeitskopie (mit -clone anlegen)", *repo)
		}
		run("", "git", "clone", "--branch", *branch, "--single-branch", *cloneURL, *repo)
	} else if *push {
		run(*repo, "git", "fetch", "origin", *branch)
		run(*repo, "git", "reset", "--hard", "origin/"+*branch)
		run(*repo, "git", "clean", "-fdq") // Reste eines früheren Laufs (z. B. ohne -push)
	}
	opt := cdn.PackOptions{Data: *data, Out: *repo, State: *state, Log: log.Printf}
	if *only != "" {
		opt.Only = strings.Split(*only, ",")
	}
	if err := cdn.Pack(opt); err != nil {
		log.Fatalf("Packen: %v", err)
	}
	files := changedFiles(*repo)
	if len(files) == 0 {
		log.Printf("Branch %s ist aktuell, nichts zu übertragen", *branch)
		return
	}
	log.Printf("%d Dateien neu oder geändert", len(files))
	if !*push {
		log.Printf("ohne -push: nichts committet")
		return
	}
	sortFiles(files)
	var group []string
	var size int64
	n := 0
	flush := func(last bool) {
		if len(group) == 0 {
			return
		}
		n++
		run(*repo, append([]string{"git", "add", "--"}, group...)...)
		run(*repo, "git", "-c", "user.name=MapViewer3D data sync", "-c", "user.email=noreply@users.noreply.github.com",
			"commit", "-q", "-m", fmt.Sprintf("%s (part %d)", *msg, n))
		run(*repo, "git", "push", "-q", "origin", "HEAD:"+*branch)
		log.Printf("Paket %d übertragen (%d Dateien, %.1f MB)", n, len(group), float64(size)/1048576)
		group, size = nil, 0
	}
	for _, f := range files {
		st, err := os.Stat(filepath.Join(*repo, f))
		if err != nil {
			continue
		}
		if size+st.Size() > int64(*batch)<<20 && len(group) > 0 && !isIndex(f) {
			flush(false)
		}
		group = append(group, f)
		size += st.Size()
	}
	flush(true)
}

// isIndex: Dateien, die immer in das letzte Paket gehören (Indizes und Katalog).
func isIndex(f string) bool { return strings.HasPrefix(f, "m/") || f == "catalog.json" }

// sortFiles: erst Kacheln und Modelle, dann Indizes, zuletzt der Katalog.
func sortFiles(files []string) {
	rank := func(f string) int {
		switch {
		case f == "catalog.json":
			return 2
		case strings.HasPrefix(f, "m/"):
			return 1
		}
		return 0
	}
	sort.SliceStable(files, func(i, j int) bool {
		if ri, rj := rank(files[i]), rank(files[j]); ri != rj {
			return ri < rj
		}
		return files[i] < files[j]
	})
}

func changedFiles(repo string) []string {
	out := output(repo, "git", "status", "--porcelain", "--untracked-files=all", "-z")
	var files []string
	for _, e := range strings.Split(out, "\x00") {
		if len(e) > 3 {
			files = append(files, e[3:])
		}
	}
	return files
}

func output(dir string, args ...string) string {
	cmd := exec.Command(args[0], args[1:]...)
	cmd.Dir = dir
	var b, e bytes.Buffer
	cmd.Stdout, cmd.Stderr = &b, &e
	if err := cmd.Run(); err != nil {
		log.Fatalf("%s: %v\n%s", strings.Join(args, " "), err, e.String())
	}
	return b.String()
}

func run(dir string, args ...string) {
	cmd := exec.Command(args[0], args[1:]...)
	cmd.Dir = dir
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		log.Fatalf("%s: %v", strings.Join(args, " "), err)
	}
}
