package updater

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// packageBinary ist der Name des Programms für dieses System im Update-Paket.
func packageBinary(prefix string) string {
	n := prefix + "-" + runtime.GOOS + "-" + runtime.GOARCH
	if runtime.GOOS == "windows" {
		n += ".exe"
	}
	return n
}

// Targets, die der Viewer neben dem Programm austauscht, sofern sie am Ziel existieren
// (eine Server-Installation hat z. B. kein docs/ und keine README).
var viewerDirs = []string{"viewer", "docs", "backend"}
var viewerFiles = []string{"README.md", "README.de.md", "CHANGELOG - DE.md", "CHANGELOG - EN.md",
	"Description-EN.md", "LICENSE", "start.sh", "start.command", "start.bat"}

// ViewerPlan: das laufende Programm (exe) und die Oberfläche werden ersetzt. Mit built
// stammt das Programm aus Prepare (stage/bin/mapviewer, selbst gebaut), sonst aus dem
// Paket (bin/mapviewer-<os>-<arch>); dann werden auch die übrigen Dateien in bin/
// ersetzt, die es am Ziel schon gibt (andere Systeme, mvagent).
func ViewerPlan(root, exe string, built bool) func(stage string) ([]Op, error) {
	return func(stage string) ([]Op, error) {
		src := filepath.Join(stage, "bin", packageBinary("mapviewer"))
		if built {
			src = filepath.Join(stage, "bin", "mapviewer")
		}
		if _, err := os.Stat(src); err != nil {
			return nil, fmt.Errorf("Programm fehlt im Paket: %s", filepath.Base(src))
		}
		if _, err := os.Stat(filepath.Join(stage, "viewer", "index.html")); err != nil {
			return nil, fmt.Errorf("viewer/ fehlt im Paket")
		}
		ops := []Op{{src, exe}}
		if !built {
			ents, _ := os.ReadDir(filepath.Join(stage, "bin"))
			for _, e := range ents {
				dest := filepath.Join(root, "bin", e.Name())
				if e.IsDir() || e.Name() == filepath.Base(src) || filepath.Clean(dest) == filepath.Clean(exe) {
					continue
				}
				if _, err := os.Lstat(dest); err == nil {
					ops = append(ops, Op{filepath.Join(stage, "bin", e.Name()), dest})
				}
			}
		}
		for _, d := range viewerDirs {
			dest := filepath.Join(root, d)
			if _, err := os.Stat(filepath.Join(stage, d)); err == nil && exists(dest) {
				ops = append(ops, Op{filepath.Join(stage, d), dest})
			}
		}
		for _, f := range viewerFiles {
			dest := filepath.Join(root, f)
			if _, err := os.Stat(filepath.Join(stage, f)); err == nil && exists(dest) {
				ops = append(ops, Op{filepath.Join(stage, f), dest})
			}
		}
		return ops, nil
	}
}

func exists(p string) bool { _, err := os.Lstat(p); return err == nil }

// BuildPrepare baut das Programm aus dem Quelltext im Paket (backend/) mit
// `-tags paks` – für Server, die das Gelände neuer Coriolis-Layouts selbst bauen
// (-paks). Braucht Go und einen C++-Compiler auf dem Rechner.
func BuildPrepare(goBin, work string) func(ctx context.Context, stage, version string) error {
	return func(ctx context.Context, stage, version string) error {
		if goBin == "" {
			return fmt.Errorf("Go nicht gefunden (nötig, weil dieses Programm mit -tags paks gebaut ist)")
		}
		ctx, cancel := context.WithTimeout(ctx, 20*time.Minute)
		defer cancel()
		cmd := exec.CommandContext(ctx, goBin, "build", "-tags", "paks", "-trimpath",
			"-ldflags", "-s -w -X mapviewer3d/server.Version="+version,
			"-o", filepath.Join("..", "bin", "mapviewer"), "./cmd/mapviewer")
		cmd.Dir = filepath.Join(stage, "backend")
		goroot := filepath.Dir(filepath.Dir(goBin))
		cmd.Env = append(os.Environ(),
			"GOCACHE="+filepath.Join(work, "gocache"), "GOPATH="+filepath.Join(work, "gopath"),
			"GOTOOLCHAIN=local", "CGO_ENABLED=1", "GOROOT="+goroot,
			"PATH="+filepath.Dir(goBin)+string(os.PathListSeparator)+os.Getenv("PATH"))
		if os.Getenv("HOME") == "" {
			cmd.Env = append(cmd.Env, "HOME="+work)
		}
		if out, err := cmd.CombinedOutput(); err != nil {
			return fmt.Errorf("go build: %v\n%s", err, tail(out, 1500))
		}
		return nil
	}
}

// FindGo sucht die Go-Programmdatei (PATH, dann übliche Orte).
func FindGo() string {
	if p, err := exec.LookPath("go"); err == nil {
		return p
	}
	for _, p := range []string{"/usr/local/go/bin/go", "/usr/lib/go/bin/go", "/opt/go/bin/go"} {
		if exists(p) {
			return p
		}
	}
	return ""
}

func tail(b []byte, n int) string {
	if len(b) > n {
		b = b[len(b)-n:]
	}
	return string(bytes.TrimSpace(b))
}

// VersionSelfTest startet das neue Programm mit -version und erwartet die neue Versionsnummer.
func VersionSelfTest(binName string) func(stage string, ops []Op, version string) error {
	return func(stage string, ops []Op, version string) error {
		src := ""
		for _, op := range ops {
			if strings.HasPrefix(op.Src, filepath.Join(stage, "bin")) {
				src = op.Src
				break
			}
		}
		if src == "" {
			return fmt.Errorf("kein Programm im Paket")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		out, err := exec.CommandContext(ctx, src, "-version").CombinedOutput()
		if err != nil {
			return fmt.Errorf("%s -version: %v", binName, err)
		}
		if !strings.Contains(string(out), version) {
			return fmt.Errorf("meldet %q statt %s", strings.TrimSpace(string(out)), version)
		}
		return nil
	}
}
