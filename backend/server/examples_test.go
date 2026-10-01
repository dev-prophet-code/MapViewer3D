package server

import "testing"

// Die Beispiel-Konfiguration im Ordner examples/website muss sich laden lassen
// (die _comment-Schlüssel sind absichtlich drin und müssen ignoriert werden).
func TestExampleConfigLoads(t *testing.T) {
	c, err := LoadLiveConfig("../../examples/website/config.example.json")
	if err != nil {
		t.Fatal(err)
	}
	if c.APIBase == "" || c.Token == "" || c.AgentURL == "" || c.CDN != "auto" {
		t.Fatalf("%+v", c)
	}
}
