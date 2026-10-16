package server

import (
	"crypto/sha256"
	"encoding/base64"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"
)

var (
	inlineScript = regexp.MustCompile(`(?s)<script(?:\s[^>]*)?>(.*?)</script>`)
	cspMu        sync.Mutex
	cspCached    map[string]struct {
		mod time.Time
		val string
	}
)

// contentSecurityPolicy liefert die CSP für index.html. Alles kommt vom eigenen
// Server (three.js liegt in viewer/vendor/); nur die eingebettete Import-Map darf
// als Inline-Skript laufen, und zwar per Hash. Die Seite darf eingebettet werden
// (kein frame-ancestors), z. B. im Dune-Docker-Console-Addon.
// Gibt "" zurück, wenn die Datei nicht lesbar ist.
func contentSecurityPolicy(indexFile string) string {
	st, err := os.Stat(indexFile)
	if err != nil {
		return ""
	}
	cspMu.Lock()
	if c, ok := cspCached[indexFile]; ok && c.mod.Equal(st.ModTime()) {
		cspMu.Unlock()
		return c.val
	}
	cspMu.Unlock()

	b, err := os.ReadFile(indexFile)
	if err != nil {
		return ""
	}
	scripts := []string{"'self'"}
	for _, m := range inlineScript.FindAllStringSubmatch(string(b), -1) {
		if strings.TrimSpace(m[1]) == "" {
			continue
		}
		sum := sha256.Sum256([]byte(m[1]))
		scripts = append(scripts, "'sha256-"+base64.StdEncoding.EncodeToString(sum[:])+"'")
	}
	val := strings.Join([]string{
		"default-src 'self'",
		"script-src " + strings.Join(scripts, " "),
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' data: blob:",
		"connect-src 'self'",
		"font-src 'self' data:",
		"worker-src 'self' blob:",
		"object-src 'none'",
		"base-uri 'none'",
		"form-action 'self'",
	}, "; ")

	cspMu.Lock()
	if cspCached == nil {
		cspCached = make(map[string]struct {
			mod time.Time
			val string
		})
	}
	cspCached[indexFile] = struct {
		mod time.Time
		val string
	}{mod: st.ModTime(), val: val}
	cspMu.Unlock()
	return val
}
