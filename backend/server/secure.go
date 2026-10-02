package server

// ---------- Verschlüsselter Eingang (mvtls) ----------
//
// Der Dune-Docker-Host kann neben der Console einen verschlüsselten Eingang
// betreiben (Branch ddp, Container mvtls): HTTPS mit eigenem, langlebigem
// Schlüssel, der unverändert an die Console weiterleitet. Der Viewer erkennt ihn
// selbst:
//
//   - Ist die Console per http:// (nicht lokal) angebunden, wird auf demselben
//     Host kurz (3 s) der Port 8797 angefragt: TLS-Handshake ohne Prüfung, nur
//     um den Fingerabdruck des Schlüssels zu lesen, und GET /mvtls zur
//     Identifikation. Dabei geht kein Token und kein Geheimnis hinaus.
//   - Antwortet dort ein mvtls, bietet die Oberfläche an, ab jetzt den
//     verschlüsselten Weg zu nutzen. Der Fingerabdruck wird angezeigt und muss
//     vom Menschen mit dem auf dem Server verglichen werden – nur so ist ein
//     Angreifer im Netz ausgeschlossen. Erst nach der Bestätigung wird
//     umgestellt (Zertifikat angeheftet, Token wird erst danach gesendet).
//   - Kennt der Viewer den Fingerabdruck schon (-api-pin), wird ohne Rückfrage
//     umgestellt.
//
//	POST /api/setup/secure   {accept, pin}   annehmen oder ablehnen

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"mapviewer3d/secure"
)

// Variablen statt Konstanten, damit Tests einen lokalen Eingang ansprechen können.
var (
	secureFrontPort       = "8797"
	secureProbeAllowLocal = false
	secureProbeTimeout    = 3 * time.Second
)

// MV_SECURE_PORT (nur für Entwickler/Tests): anderer Port des Eingangs; sucht ihn
// dann auch auf dem eigenen Rechner.
func init() {
	if p := os.Getenv("MV_SECURE_PORT"); p != "" {
		secureFrontPort, secureProbeAllowLocal = p, true
	}
}

// secureOffer: ein erkannter Eingang für den aktiven Server.
type secureOffer struct {
	ForID string `json:"-"`
	URL   string `json:"url"`
	Pin   string `json:"pin"`
}

type secureState struct {
	mu    sync.Mutex
	offer *secureOffer
	gen   int
}

func (s *Server) secureDeclinedFile() string {
	return filepath.Join(s.stateDir, "secure-declined.json")
}

func (s *Server) secureDeclined(id string) bool {
	var ids []string
	if b, err := os.ReadFile(s.secureDeclinedFile()); err == nil {
		json.Unmarshal(b, &ids)
	}
	return slices.Contains(ids, id)
}

func (s *Server) markSecureDeclined(id string) {
	var ids []string
	if b, err := os.ReadFile(s.secureDeclinedFile()); err == nil {
		json.Unmarshal(b, &ids)
	}
	if !slices.Contains(ids, id) {
		ids = append(ids, id)
	}
	b, _ := json.Marshal(ids)
	os.WriteFile(s.secureDeclinedFile(), b, 0o600)
}

// currentOffer liefert das Angebot für den aktiven Server (oder nil).
func (s *Server) currentOffer() *secureOffer {
	lp := s.lp()
	s.secure.mu.Lock()
	defer s.secure.mu.Unlock()
	if lp == nil || s.secure.offer == nil || s.secure.offer.ForID != serverID(lp.cfg.APIBase) {
		return nil
	}
	o := *s.secure.offer
	return &o
}

func (s *Server) setOffer(o *secureOffer) {
	s.secure.mu.Lock()
	s.secure.offer = o
	s.secure.mu.Unlock()
}

// refreshSecureOffer sucht im Hintergrund nach dem verschlüsselten Eingang des
// aktiven Servers. Läuft nur für nicht-lokale http://-Verbindungen im Browser-
// Betrieb (nicht mit fester Konfiguration, die der Betreiber selbst setzt).
func (s *Server) refreshSecureOffer() {
	lp := s.lp()
	s.secure.mu.Lock()
	s.secure.gen++
	gen := s.secure.gen
	s.secure.offer = nil
	s.secure.mu.Unlock()
	if lp == nil {
		return
	}
	u, err := url.Parse(lp.cfg.APIBase)
	if err != nil || u.Scheme != "http" || (consoleIsLocal(u) && !secureProbeAllowLocal) {
		return
	}
	if s.fixed {
		go s.hintFixedSecure(u)
		return
	}
	if s.store == nil {
		return
	}
	id := serverID(lp.cfg.APIBase)
	if s.secureDeclined(id) {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), secureProbeTimeout+2*time.Second)
		defer cancel()
		frontURL, pin, err := probeFront(ctx, u)
		if err != nil {
			return
		}
		s.secure.mu.Lock()
		stale := s.secure.gen != gen
		s.secure.mu.Unlock()
		if stale {
			return
		}
		log.Printf("Verschlüsselter Eingang gefunden: %s (Fingerabdruck %s)", frontURL, pin)
		if p := consoleFlagPin.Load(); p != nil && *p == pin {
			// Der Fingerabdruck ist dem Viewer schon bekannt (-api-pin): ohne Rückfrage nutzen
			if err := s.useSecure(&secureOffer{ForID: id, URL: frontURL, Pin: pin}, false); err != nil {
				log.Printf("Verschlüsselter Eingang: %v", err)
			}
			return
		}
		s.setOffer(&secureOffer{ForID: id, URL: frontURL, Pin: pin})
	}()
}

// hintFixedSecure: mit fester Konfiguration stellt der Viewer nicht selbst um,
// weist aber im Log darauf hin.
func (s *Server) hintFixedSecure(u *url.URL) {
	ctx, cancel := context.WithTimeout(context.Background(), secureProbeTimeout+2*time.Second)
	defer cancel()
	if frontURL, pin, err := probeFront(ctx, u); err == nil {
		log.Printf("Der Server bietet einen verschlüsselten Eingang an: %s (Fingerabdruck %s). Mit fester Konfiguration selbst setzen: apiBase \"%s\" und apiPin \"%s\".", frontURL, pin, frontURL, pin)
	}
}

// probeFront fragt auf dem Host der Console den Port des Eingangs ab. Es wird kein
// Token und kein Geheimnis gesendet; der Fingerabdruck ist nur eine Information
// für den Menschen, der ihn vergleicht.
func probeFront(ctx context.Context, console *url.URL) (frontURL, pin string, err error) {
	host := console.Hostname()
	addr := net.JoinHostPort(host, secureFrontPort)
	ctx, cancel := context.WithTimeout(ctx, secureProbeTimeout)
	defer cancel()
	pin, err = peerPin(ctx, addr)
	if err != nil {
		return "", "", err
	}
	c := &http.Client{
		Timeout:       secureProbeTimeout,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		Transport:     newConsoleTransportWith(&net.Dialer{Timeout: secureProbeTimeout}, func() string { return pin }),
	}
	defer c.CloseIdleConnections()
	frontURL = "https://" + addr
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, frontURL+"/mvtls", nil)
	resp, err := c.Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()
	var doc struct {
		MV   int  `json:"mapviewer-tls"`
		Full bool `json:"full"`
	}
	if resp.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(resp.Body, 4<<10)).Decode(&doc) != nil || doc.MV != 1 {
		return "", "", errNotFront
	}
	return frontURL, pin, nil
}

var errNotFront = &setupError{"not_console", ""}

// useSecure stellt die aktive Verbindung auf den verschlüsselten Eingang um: erst
// prüfen (Zertifikat angeheftet, Token wird verschlüsselt gesendet), dann
// speichern. Der bisherige http://-Eintrag wird durch den neuen ersetzt;
// Instanznamen ziehen mit.
func (s *Server) useSecure(o *secureOffer, local bool) error {
	cur, err := s.store.Load()
	if err != nil {
		return err
	}
	oldID := serverID(cur.APIBase)
	if oldID != o.ForID {
		return &setupError{"bad_request", "server"}
	}
	if err := checkConsole(o.URL, cur.Token, o.Pin, local); err != nil {
		return err
	}
	c := secure.Credentials{APIBase: o.URL, Token: cur.Token, Pin: o.Pin}
	if err := s.store.Save(c); err != nil {
		return err
	}
	s.rememberServer(c)
	if newID := serverID(c.APIBase); newID != oldID {
		oldNames := filepath.Join(s.stateDir, "instance-names-"+oldID+".json")
		if b, err := os.ReadFile(oldNames); err == nil {
			os.WriteFile(filepath.Join(s.stateDir, "instance-names-"+newID+".json"), b, 0o600)
		}
		if st, err := s.serverStore(oldID); err == nil {
			st.Delete()
		}
		os.Remove(oldNames)
	}
	s.activate(c)
	log.Printf("Verbindung zur Console jetzt verschlüsselt: %s (Fingerabdruck %s)", o.URL, o.Pin)
	return nil
}

// secureAccept: POST /api/setup/secure {accept, pin}
func (s *Server) secureAccept(w http.ResponseWriter, r *http.Request) {
	if !s.guard(w, r) {
		return
	}
	var in struct {
		Accept bool   `json:"accept"`
		Pin    string `json:"pin"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&in); err != nil {
		fail(w, http.StatusBadRequest, "bad_request", "")
		return
	}
	o := s.currentOffer()
	if o == nil {
		fail(w, http.StatusConflict, "no_secure_offer", "")
		return
	}
	if !in.Accept {
		s.markSecureDeclined(o.ForID)
		s.setOffer(nil)
		s.setupStatus(w, r)
		return
	}
	// Der Mensch bestätigt genau den angezeigten Fingerabdruck; der Server prüft
	// ihn noch einmal frisch, bevor er das Token sendet.
	if in.Pin != o.Pin {
		fail(w, http.StatusBadRequest, "pin_format", "")
		return
	}
	u, _ := url.Parse(o.URL)
	base, _ := url.Parse("http://" + u.Hostname())
	ctx, cancel := context.WithTimeout(r.Context(), secureProbeTimeout+2*time.Second)
	defer cancel()
	if _, fresh, err := probeFront(ctx, base); err != nil || fresh != o.Pin {
		failErr(w, http.StatusBadGateway, &setupError{"cert_pin", ""})
		return
	}
	if err := s.useSecure(o, isLocalRequest(r)); err != nil {
		failErr(w, http.StatusBadGateway, err)
		return
	}
	s.setupStatus(w, r)
}

func (s *Server) secureStatus(r *http.Request) any {
	if s.fixed || !s.adminAllowed(r) {
		return nil
	}
	if o := s.currentOffer(); o != nil {
		return o
	}
	return nil
}

func (s *Server) activeHTTPS() bool {
	lp := s.lp()
	return lp != nil && strings.HasPrefix(lp.cfg.APIBase, "https://")
}
