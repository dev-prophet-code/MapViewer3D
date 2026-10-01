package server

// Echtzeitdaten von einem Dune-Docker-Host (mvgate, Branch ddp).
//
// Der Viewer fragt nur kurz nach (höchstens 5 s). Kommt keine Antwort, gibt es
// die Funktion auf dem Server (noch) nicht: Der Agent bleibt aus, /api/live/status
// meldet agent=false und die Oberfläche blendet die Schalter für Würmer, Gegner,
// Zivilisten und Fahrzeuge gar nicht erst ein. Alle 10 Minuten (und nach einer
// neuen Einrichtung der Console) wird erneut gefragt; neue Schalter erscheinen
// dann beim nächsten Laden der Seite.
//
//   - Mit Kopplungscode (-agent-pair, agentPairing): Verbindung zum mvgate über
//     securelink (TLS 1.3, festgelegter Schlüssel, gegenseitiger Token-Nachweis;
//     das Token verlässt den Rechner nie).
//   - Ohne Kopplungscode: Frage an die Console, ob sie die Funktion anbietet
//     (consoleLivePath). Heute antwortet keine Console darauf; bietet sie es an,
//     sagt das Log, dass ein Kopplungscode vom Server-Admin nötig ist. Die Console
//     liefert nie das Token – freigeschaltet wird nur durch den Kopplungscode.

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"mapviewer3d/securelink"
)

const (
	liveProbeTimeout = 5 * time.Second
	liveRecheck      = 10 * time.Minute
	// consoleLivePath: Fähigkeitsabfrage an die Dune-Docker-Console (Vorschlag,
	// SECURITY.md im Branch ddp). Antwort {"available":true,"version":1}.
	consoleLivePath = "/api/mapviewer-live/status"
)

// liveOffer ist die Antwort der Console auf consoleLivePath.
type liveOffer struct {
	Available bool `json:"available"`
	Version   int  `json:"version"`
}

// StartLiveDiscovery fragt im Hintergrund nach, ob der Dune-Docker-Host
// Echtzeitdaten anbietet, und schaltet den Agenten erst bei einer gültigen
// Antwort ein. pairing darf nil sein.
func (s *Server) StartLiveDiscovery(ctx context.Context, pairing *securelink.Pairing) {
	go s.liveDiscovery(ctx, pairing, liveRecheck)
}

func (s *Server) liveDiscovery(ctx context.Context, pairing *securelink.Pairing, every time.Duration) {
	last := ""
	report := func(state, msg string) {
		if state != last {
			log.Print(msg)
			last = state
		}
	}
	for ctx.Err() == nil {
		if s.agentLink() != nil {
			return // fester Agent (-agent) oder schon verbunden
		}
		if pairing != nil {
			err := probeGate(ctx, *pairing)
			switch {
			case err == nil:
				s.UseAgentPairing(*pairing)
				log.Printf("Echtzeitdaten: %s geprüft (TLS 1.3, Schlüssel passt, gegenseitiger Nachweis) – Würmer, Gegner und Fahrzeuge live", pairing)
				return
			case errors.Is(err, securelink.ErrPin) || strings.Contains(err.Error(), "pinned fingerprint"):
				report("pin", "Echtzeitdaten: ACHTUNG – der Server zeigt einen anderen Schlüssel als im Kopplungscode (möglicher Angriff oder neu aufgesetztes mvgate). Keine Verbindung, Schalter ausgeblendet.")
			case errors.Is(err, securelink.ErrAuth) || strings.Contains(err.Error(), "authentication failed"):
				report("auth", "Echtzeitdaten: mvgate lehnt den Kopplungscode ab (Token geändert?) – neuen Code beim Server-Admin holen. Schalter ausgeblendet.")
			default:
				report("gone", "Echtzeitdaten: keine Antwort von "+pairing.Addr+" – Dune Docker hat die Funktion (noch) nicht oder sie läuft nicht. Schalter ausgeblendet.")
			}
		} else if lp := s.lp(); lp != nil {
			if offer, err := askConsole(ctx, lp.cfg); err == nil && offer.Available {
				report("offer", "Echtzeitdaten: Dune Docker bietet sie an – zum Freischalten einen Kopplungscode vom Server-Admin holen und mit -agent-pair (oder agentPairing) angeben.")
			} else {
				report("none", "Echtzeitdaten: Dune Docker hat die Funktion (noch) nicht – Schalter für Würmer, Gegner und Fahrzeuge ausgeblendet.")
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(every):
		case <-s.liveKick:
		}
	}
}

// probeGate baut eine securelink-Verbindung auf und fragt /healthz.
func probeGate(ctx context.Context, p securelink.Pairing) error {
	ctx, cancel := context.WithTimeout(ctx, liveProbeTimeout)
	defer cancel()
	c := &http.Client{Transport: securelink.Transport(p)}
	defer c.CloseIdleConnections()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "https://mvgate/healthz", nil)
	resp, err := c.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return errors.New(resp.Status)
	}
	return nil
}

// askConsole fragt die Console kurz, ob sie Echtzeitdaten anbietet.
func askConsole(ctx context.Context, cfg *LiveConfig) (liveOffer, error) {
	var o liveOffer
	ctx, cancel := context.WithTimeout(ctx, liveProbeTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(cfg.APIBase, "/")+consoleLivePath, nil)
	if err != nil {
		return o, err
	}
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	req.Header.Set("Accept", "application/json")
	c := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := c.Do(req)
	if err != nil {
		return o, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK || !strings.HasPrefix(resp.Header.Get("Content-Type"), "application/json") {
		return o, errors.New(resp.Status)
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&o); err != nil {
		return o, err
	}
	return o, nil
}
