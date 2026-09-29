package server

import (
	"crypto/sha256"
	"encoding/base64"
	"os"
	"regexp"
	"strings"
)

var inlineScript = regexp.MustCompile(`(?s)<script(?:\s[^>]*)?>(.*?)</script>`)

// contentSecurityPolicy liefert die CSP für index.html. Alles kommt vom eigenen
// Server (three.js liegt in viewer/vendor/); nur die eingebettete Import-Map darf
// als Inline-Skript laufen, und zwar per Hash. Die Seite darf eingebettet werden
// (kein frame-ancestors), z. B. im Dune-Docker-Console-Addon.
// Gibt "" zurück, wenn die Datei nicht lesbar ist.
func contentSecurityPolicy(indexFile string) string {
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
	return strings.Join([]string{
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
}
