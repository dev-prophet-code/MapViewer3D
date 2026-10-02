package server

// Realtime Data von Dune Docker: Sandwürmer, Gegner, Zivilisten, Fahrzeuge und
// Stürme, die der Positions-Agent (mvagent, Branch ddp) aus den Spielservern
// liest und die Console unter /api/realtime/* weitergibt – nur für API-Keys mit
// dem Recht "Realtime Data" (Spieler zusätzlich nur mit "Players: Read").
//
// Ohne eigenen Agenten (-agent) fragt der Viewer die Console kurz (höchstens 5 s)
// mit seinem API-Key. Kommt keine passende Antwort, bleibt alles aus:
// /api/live/status meldet agent=false und die Oberfläche blendet die Schalter
// nicht ein. Gründe: Console ohne die Funktion, Agent läuft nicht, Key ohne das
// Recht, Console nicht per HTTPS (außer auf demselben Rechner) oder Zertifikat
// nicht vertrauenswürdig. Alle 10 Minuten und nach einer neuen Einrichtung der
// Console wird erneut gefragt; neue Schalter erscheinen beim nächsten Laden.

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	realtimeProbeTimeout = 5 * time.Second
	realtimeRecheck      = 10 * time.Minute
	realtimePath         = "/api/realtime"
	// Text der Console, wenn der Route ein Recht fehlt, das der Key nicht hat;
	// unbekannte Routen (Console ohne die Funktion) liefern einen anderen 403-Text.
	consoleKeyScopeDenied = "API key is not permitted"
)

// realtimeProbe ist das Ergebnis einer Anfrage: state für das Log (nur bei
// Änderung), ok = einschalten.
type realtimeProbe struct {
	state, msg string
	ok         bool
}

// StartRealtime fragt im Hintergrund bei der Console nach Realtime Data.
func (s *Server) StartRealtime(ctx context.Context) {
	s.realtimeOn.Store(true)
	go s.realtimeLoop(ctx, realtimeRecheck)
}

// logRealtime schreibt das Ergebnis nur, wenn es sich geändert hat (Verbindungen
// werden immer gemeldet, auch nach einem Serverwechsel zum selben Ergebnis).
func (s *Server) logRealtime(p realtimeProbe) {
	prev := s.realtimeLast.Swap(&p.state)
	if p.ok || prev == nil || *prev != p.state {
		log.Print("Echtzeitdaten: " + p.msg)
	}
}

func (s *Server) realtimeLoop(ctx context.Context, every time.Duration) {
	for ctx.Err() == nil {
		s.realtimeMu.Lock()
		if s.agentLink() == nil {
			if lp := s.lp(); lp != nil {
				p := probeRealtime(ctx, lp.cfg)
				s.logRealtime(p)
				if p.ok && s.lp() == lp {
					s.useRealtime(lp.cfg)
				}
			}
		}
		s.realtimeMu.Unlock()
		select {
		case <-ctx.Done():
			return
		case <-time.After(every):
		case <-s.liveKick:
		}
	}
}

// useRealtime verbindet den Live-Strom der Console wie einen Agenten.
func (s *Server) useRealtime(cfg *LiveConfig) {
	base := strings.TrimRight(cfg.APIBase, "/") + realtimePath
	l := &agentLink{
		base:     base,
		client:   newConsoleClient(0),
		header:   http.Header{"Authorization": {"Bearer " + cfg.Token}},
		label:    base,
		realtime: true,
	}
	l.denied = func() { s.dropAgent(l) }
	s.startAgent(l)
}

// dropAgent trennt l, falls es noch der aktuelle Agent ist, und fragt neu.
func (s *Server) dropAgent(l *agentLink) {
	s.dropAgentQuiet(l)
	s.kickRealtime()
}

func (s *Server) dropAgentQuiet(l *agentLink) {
	s.agentMu.Lock()
	if s.agent == l {
		s.agent = nil
	}
	s.agentMu.Unlock()
	l.stop()
}

func (s *Server) kickRealtime() {
	select {
	case s.liveKick <- struct{}{}:
	default:
	}
}

// consoleIsLocal: Console auf demselben Rechner (dann darf es HTTP sein).
func consoleIsLocal(u *url.URL) bool {
	host := u.Hostname()
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func probeRealtime(ctx context.Context, cfg *LiveConfig) realtimeProbe {
	u, err := url.Parse(strings.TrimRight(cfg.APIBase, "/"))
	if err != nil || u.Host == "" {
		return realtimeProbe{state: "badurl", msg: "Adresse der Console ungültig – Schalter ausgeblendet."}
	}
	if u.Scheme != "https" && !consoleIsLocal(u) {
		return realtimeProbe{state: "http", msg: "die Console ist nicht per HTTPS angebunden (" + u.Scheme + "://" + u.Host + "). Realtime Data gibt es nur verschlüsselt oder auf demselben Rechner – Schalter ausgeblendet."}
	}
	ctx, cancel := context.WithTimeout(ctx, realtimeProbeTimeout)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, u.String()+realtimePath+"/healthz", nil)
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	req.Header.Set("Accept", "application/json")
	c := newConsoleClient(0)
	c.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	defer c.CloseIdleConnections()
	resp, err := c.Do(req)
	if err != nil {
		switch {
		case errors.Is(err, errConsolePin):
			return realtimeProbe{state: "pin", msg: "ACHTUNG – die Console zeigt einen anderen Schlüssel als mit -api-pin festgelegt (möglicher Angriff oder neues Zertifikat). Keine Verbindung, Schalter ausgeblendet."}
		case isCertError(err):
			msg := "das Zertifikat der Console ist nicht vertrauenswürdig (selbst signiert oder intern?) – Schalter ausgeblendet."
			pctx, pcancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer pcancel()
			if pin, perr := peerPin(pctx, hostPort(u)); perr == nil {
				msg += " Fingerabdruck: " + pin + " – auf dem Server vergleichen und mit -api-pin " + pin + " festlegen."
			}
			return realtimeProbe{state: "cert", msg: msg}
		default:
			return realtimeProbe{state: "gone", msg: "keine Antwort der Console – Schalter ausgeblendet."}
		}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	var doc struct {
		Available bool   `json:"available"`
		Error     string `json:"error"`
	}
	json.Unmarshal(body, &doc)
	switch {
	case resp.StatusCode == http.StatusOK && doc.Available:
		return realtimeProbe{state: "ok", ok: true, msg: "Dune Docker liefert Realtime Data (" + u.Scheme + "://" + u.Host + ") – Würmer, Gegner und Fahrzeuge live"}
	case resp.StatusCode == http.StatusForbidden && strings.Contains(doc.Error, consoleKeyScopeDenied):
		return realtimeProbe{state: "scope", msg: "der API-Key hat kein Recht \"Realtime Data\" (Console: Settings → API Keys) – Schalter ausgeblendet."}
	case resp.StatusCode == http.StatusUnauthorized:
		return realtimeProbe{state: "key", msg: "die Console lehnt den API-Key ab – Schalter ausgeblendet."}
	case resp.StatusCode == http.StatusServiceUnavailable:
		return realtimeProbe{state: "agent", msg: "Dune Docker kennt Realtime Data, aber der Positions-Agent läuft dort nicht – Schalter ausgeblendet."}
	default:
		return realtimeProbe{state: "none", msg: "Dune Docker hat die Funktion Realtime Data (noch) nicht – Schalter für Würmer, Gegner und Fahrzeuge ausgeblendet."}
	}
}

func hostPort(u *url.URL) string {
	if u.Port() != "" {
		return u.Host
	}
	if u.Scheme == "https" {
		return net.JoinHostPort(u.Hostname(), "443")
	}
	return net.JoinHostPort(u.Hostname(), "80")
}
