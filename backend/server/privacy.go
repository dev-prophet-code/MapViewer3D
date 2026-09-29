package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"time"
)

// Konten-Kennungen gehen nur an den Administrator auf dem Rechner selbst
// (adminAllowed). Alle anderen Besucher bekommen die Live-Daten ohne diese Felder,
// auch wenn der Viewer im Netz erreichbar ist und -public nicht gesetzt wurde.
// Im öffentlichen Betrieb (-public) übernimmt das filterRows.

type strippedBody struct {
	src  time.Time // Zeitstempel der Console-Antwort
	body []byte
}

// stripPrivate entfernt privateFields aus einer Console-Antwort (rekursiv) und
// merkt sich das Ergebnis, solange die Console-Antwort dieselbe bleibt.
func (s *Server) stripPrivate(path string, c *cached) *cached {
	if c.status != http.StatusOK {
		return c
	}
	if v, ok := s.stripped.Load(path); ok {
		if f := v.(strippedBody); f.src.Equal(c.at) {
			return &cached{at: c.at, status: c.status, body: f.body}
		}
	}
	dec := json.NewDecoder(bytes.NewReader(c.body))
	dec.UseNumber()
	var doc any
	if err := dec.Decode(&doc); err != nil {
		return &cached{at: c.at, status: http.StatusBadGateway, body: jsonError("Live-Daten unlesbar")}
	}
	removePrivate(doc)
	body, err := json.Marshal(doc)
	if err != nil {
		return &cached{at: c.at, status: http.StatusBadGateway, body: jsonError("Live-Daten unlesbar")}
	}
	s.stripped.Store(path, strippedBody{src: c.at, body: body})
	return &cached{at: c.at, status: c.status, body: body}
}

func removePrivate(v any) {
	switch x := v.(type) {
	case map[string]any:
		for _, k := range privateFields {
			delete(x, k)
		}
		for _, e := range x {
			removePrivate(e)
		}
	case []any:
		for _, e := range x {
			removePrivate(e)
		}
	}
}
