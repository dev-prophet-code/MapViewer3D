package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"mapviewer3d/secure"
)

// ---------- Einrichtung der Verbindung ----------
//
//	GET    /api/setup          eingerichtet? Server (ohne Token), Fingerabdruck
//	POST   /api/setup          {server, port, token} prüfen und verschlüsselt speichern
//	DELETE /api/setup          Zugangsdaten löschen
//	GET    /api/setup/labels   Instanzen mit Namen (automatisch bzw. selbst vergeben)
//	POST   /api/setup/labels   {partitionId: Name} speichern (nicht geheim)

// setupError ist ein Fehler mit Code, den die Oberfläche übersetzt (i18n.js: err.<code>).
type setupError struct{ code, detail string }

func (e *setupError) Error() string { return e.code + ": " + e.detail }

func fail(w http.ResponseWriter, status int, code, detail string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"code": code, "detail": detail, "error": code})
}

func failErr(w http.ResponseWriter, status int, err error) {
	var se *setupError
	if errors.As(err, &se) {
		fail(w, status, se.code, se.detail)
		return
	}
	fail(w, status, "save_failed", err.Error())
}

// sameOrigin schützt die ändernden Aufrufe vor fremden Webseiten (CSRF): nur
// Anfragen der eigenen Oberfläche mit gesetztem Kopf werden angenommen.
func sameOrigin(r *http.Request) bool {
	if r.Header.Get("X-MapViewer") != "1" {
		return false
	}
	o := r.Header.Get("Origin")
	if o == "" {
		return true
	}
	u, err := url.Parse(o)
	return err == nil && u.Host == r.Host
}

// adminAllowed: Zugangsdaten und Instanznamen ändern darf nur ein Browser auf
// demselben Rechner, außer der Server läuft mit -remote-setup. So kann ein
// öffentlich betriebener Viewer nicht von Besuchern umgestellt werden.
//
// Verweigert wird standardmäßig: "lokal" ist nur, was ausdrücklich lokal aussieht
// (siehe isLocalRequest). Mit -no-local-admin gilt nie eine Anfrage als lokal,
// z. B. hinter einem Reverse-Proxy auf demselben Rechner.
func (s *Server) adminAllowed(r *http.Request) bool {
	if s.RemoteSetup {
		return true
	}
	if s.NoLocalAdmin {
		return false
	}
	return isLocalRequest(r)
}

// isLocalRequest: Die Anfrage kommt von einer Loopback-Adresse, trägt keine
// Proxy-Kopfzeile und richtet sich an einen Loopback-Namen (localhost, 127.0.0.1,
// [::1]). Ein Reverse-Proxy auf demselben Rechner reicht meist den öffentlichen
// Host-Namen durch und gilt damit auch dann als entfernt, wenn er keine
// X-Forwarded-Kopfzeile setzt; das schützt auch vor DNS-Rebinding.
func isLocalRequest(r *http.Request) bool {
	for _, h := range []string{"Forwarded", "X-Forwarded-For", "X-Forwarded-Host", "X-Real-Ip"} {
		if r.Header.Get(h) != "" {
			return false
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return false
	}
	if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
		return false
	}
	return hostIsLoopback(r.Host)
}

// hostIsLoopback prüft den Host-Teil eines Host-Headers.
func hostIsLoopback(hostport string) bool {
	h := hostport
	if hh, _, err := net.SplitHostPort(hostport); err == nil {
		h = hh
	}
	h = strings.Trim(h, "[]")
	if strings.EqualFold(h, "localhost") {
		return true
	}
	ip := net.ParseIP(h)
	return ip != nil && ip.IsLoopback()
}

// guard prüft Herkunft und Berechtigung eines ändernden Aufrufs.
func (s *Server) guard(w http.ResponseWriter, r *http.Request) bool {
	if s.fixed {
		fail(w, http.StatusForbidden, "remote_forbidden", "config")
		return false
	}
	if !sameOrigin(r) {
		fail(w, http.StatusForbidden, "bad_request", "origin")
		return false
	}
	if !s.adminAllowed(r) {
		fail(w, http.StatusForbidden, "remote_forbidden", "")
		return false
	}
	return true
}

func (s *Server) setupStatus(w http.ResponseWriter, r *http.Request) {
	if s.fixed {
		// Verbindung steht in der Konfigurationsdatei; ändern kann sie nur der Betreiber dort
		writeJSON(w, map[string]any{"configured": s.lp() != nil, "stored": true, "admin": false})
		return
	}
	host, fp, ok := s.store.Info()
	admin := s.adminAllowed(r)
	if !admin {
		host, fp = "", "" // Besucher eines öffentlichen Viewers sehen die Verbindung nicht
	}
	writeJSON(w, map[string]any{"configured": ok && s.lp() != nil, "stored": ok, "server": host, "fingerprint": fp, "admin": admin,
		"https": s.activeHTTPS(), "secure": s.secureStatus(r)})
}

var tokenPattern = regexp.MustCompile(`^[A-Za-z0-9_\-.]{8,512}$`)

// normalizeServer macht aus „host“, „host:port“ oder einer URL eine Basis-URL.
func normalizeServer(server string, port int) (base, display string, err error) {
	server = strings.TrimSpace(server)
	if server == "" {
		return "", "", &setupError{"server_missing", ""}
	}
	if !strings.Contains(server, "://") {
		server = "http://" + server
	}
	u, err := url.Parse(server)
	if err != nil || u.Hostname() == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return "", "", &setupError{"server_invalid", ""}
	}
	host := u.Hostname()
	p := u.Port()
	if p == "" {
		switch {
		case u.Scheme == "https" && (port <= 0 || port == 8088):
			// https:// ohne Port ist ein Reverse Proxy (Caddy, nginx) auf 443,
			// nicht die Console selbst auf 8088
			port = 443
		case port <= 0:
			port = 8088
		}
		p = strconv.Itoa(port)
	}
	if n, err := strconv.Atoi(p); err != nil || n < 1 || n > 65535 {
		return "", "", &setupError{"port_invalid", ""}
	}
	hp := net.JoinHostPort(host, p)
	return u.Scheme + "://" + hp, hp, nil
}

// consoleClient prüft die Console. Ziele, die nie eine Console sind, werden schon
// beim Verbindungsaufbau abgelehnt (Link-Local inkl. Cloud-Metadaten 169.254.169.254,
// Multicast, 0.0.0.0) – auch nach DNS-Auflösung. Weiterleitungen werden nicht
// verfolgt und es wird kein Proxy aus der Umgebung benutzt.
// pin ist der Fingerabdruck, der für diesen Server gelten soll (-api-pin geht vor).
func setupConsoleClient(pin string) *http.Client {
	if p := consoleFlagPin.Load(); p != nil && *p != "" {
		pin = *p
	}
	tr := newConsoleTransportWith(&net.Dialer{Timeout: 10 * time.Second, Control: blockSpecialTargets}, func() string { return pin })
	tr.Proxy = nil
	return &http.Client{
		Timeout:       15 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		Transport:     tr,
	}
}

// blockSpecialTargets lehnt Zieladressen ab, die keine Console sein können.
func blockSpecialTargets(network, address string, _ syscall.RawConn) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return err
	}
	ip := net.ParseIP(host)
	if ip == nil || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified() {
		return errors.New("target not allowed")
	}
	return nil
}

// checkConsole prüft Erreichbarkeit und Token an der Kartenliste der Console.
// Nur für den Browser auf dem Rechner selbst (detailed) gibt es genaue Fehler;
// aus der Ferne (-remote-setup) bleibt es bei einem Sammelfehler, damit die
// Prüfung nicht als Port-Scanner für das interne Netz taugt.
func checkConsole(base, token, pin string, detailed bool) error {
	err := checkConsoleDetailed(base, token, pin)
	if err != nil && !detailed {
		return &setupError{"unreachable", ""}
	}
	return err
}

func checkConsoleDetailed(base, token, pin string) error {
	req, _ := http.NewRequest(http.MethodGet, base+"/api/map/partitions", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	c := setupConsoleClient(pin)
	defer c.CloseIdleConnections()
	resp, err := c.Do(req)
	if err != nil {
		switch {
		case errors.Is(err, errConsolePin):
			return &setupError{"cert_pin", ""}
		case isCertError(err):
			// selbst signiert/intern: Fingerabdruck nennen, damit man ihn auf dem
			// Server vergleichen und eintragen kann
			if u, perr := url.Parse(base); perr == nil {
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				if fp, ferr := peerPin(ctx, hostPort(u)); ferr == nil {
					return &setupError{"cert_untrusted", fp}
				}
			}
			return &setupError{"cert_untrusted", ""}
		}
		return &setupError{"unreachable", shortNetError(err)}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	switch {
	case resp.StatusCode == http.StatusUnauthorized, resp.StatusCode == http.StatusForbidden:
		return &setupError{"token_rejected", ""}
	case resp.StatusCode != http.StatusOK:
		return &setupError{"http_status", strconv.Itoa(resp.StatusCode)}
	}
	var doc struct {
		Rows []json.RawMessage `json:"rows"`
	}
	if json.Unmarshal(body, &doc) != nil {
		return &setupError{"not_console", ""}
	}
	return nil
}

func (s *Server) setupSave(w http.ResponseWriter, r *http.Request) {
	if !s.guard(w, r) {
		return
	}
	var in struct {
		Server string `json:"server"`
		Port   int    `json:"port"`
		Token  string `json:"token"`
		Pin    string `json:"pin"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&in); err != nil {
		fail(w, http.StatusBadRequest, "bad_request", "")
		return
	}
	in.Token = strings.TrimSpace(in.Token)
	if !tokenPattern.MatchString(in.Token) {
		fail(w, http.StatusBadRequest, "token_format", "")
		return
	}
	in.Pin = strings.TrimSpace(in.Pin)
	if checkPin(in.Pin) != nil {
		fail(w, http.StatusBadRequest, "pin_format", "")
		return
	}
	base, _, err := normalizeServer(in.Server, in.Port)
	if err != nil {
		failErr(w, http.StatusBadRequest, err)
		return
	}
	if err := checkConsole(base, in.Token, in.Pin, isLocalRequest(r)); err != nil {
		failErr(w, http.StatusBadGateway, err)
		return
	}
	c := secure.Credentials{APIBase: base, Token: in.Token, Pin: in.Pin}
	if err := s.store.Save(c); err != nil {
		fail(w, http.StatusInternalServerError, "save_failed", err.Error())
		return
	}
	s.rememberServer(c) // in die Serverliste (servers.go)
	s.activate(c)
	s.setupStatus(w, r)
}

func (s *Server) setupDelete(w http.ResponseWriter, r *http.Request) {
	if !s.guard(w, r) {
		return
	}
	if err := s.store.Delete(); err != nil {
		fail(w, http.StatusInternalServerError, "save_failed", err.Error())
		return
	}
	// der aktive Server verschwindet auch aus der Liste, samt seinen Namen
	if lp := s.lp(); lp != nil {
		if st, err := s.serverStore(serverID(lp.cfg.APIBase)); err == nil {
			st.Delete()
		}
	}
	os.Remove(s.labelsFile())
	s.setLive(nil)
	s.clearServerCaches()
	s.setupStatus(w, r)
}

// clearServerCaches verwirft serverabhängige Zwischenspeicher (Kartenbilder).
func (s *Server) clearServerCaches() {
	os.RemoveAll(s.mapImageDir())
	s.labelCache = sync.Map{}
	s.iconMisses = sync.Map{}
	os.RemoveAll(s.iconsDir()) // Symbole kommen vom neuen Server
}

// ---------- Namen der Serverinstanzen ----------

// labelsFile: Instanznamen je Server (Serverliste); mit fester Konfiguration
// oder ohne Verbindung die gemeinsame Datei.
func (s *Server) labelsFile() string {
	if lp := s.lp(); lp != nil && !s.fixed && s.store != nil {
		return filepath.Join(s.stateDir, "instance-names-"+serverID(lp.cfg.APIBase)+".json")
	}
	return filepath.Join(s.stateDir, "instance-names.json")
}

func (s *Server) customLabels() map[string]string {
	out := map[string]string{}
	if b, err := os.ReadFile(s.labelsFile()); err == nil {
		json.Unmarshal(b, &out)
	}
	return out
}

var labelPattern = regexp.MustCompile(`^[\p{L}\p{N} ._\-()/+&]{1,40}$`)

func (s *Server) labelsSave(w http.ResponseWriter, r *http.Request) {
	if !s.guard(w, r) {
		return
	}
	var in map[string]string
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&in); err != nil {
		fail(w, http.StatusBadRequest, "bad_request", "")
		return
	}
	out := map[string]string{}
	for k, v := range in {
		v = strings.TrimSpace(v)
		if _, err := strconv.Atoi(k); err != nil || v == "" {
			continue
		}
		if !labelPattern.MatchString(v) {
			fail(w, http.StatusBadRequest, "name_invalid", v)
			return
		}
		out[k] = v
	}
	b, _ := json.MarshalIndent(out, "", "  ")
	if err := os.WriteFile(s.labelsFile(), b, 0o600); err != nil {
		fail(w, http.StatusInternalServerError, "save_failed", err.Error())
		return
	}
	writeJSON(w, out)
}

// labelsGet liefert alle Instanzen der Karten mit automatischem und eigenem Namen.
func (s *Server) labelsGet(w http.ResponseWriter, r *http.Request) {
	type row struct {
		Map       string `json:"map"`
		Partition int    `json:"partition"`
		Internal  string `json:"internal"`
		Auto      string `json:"auto"`
		Custom    string `json:"custom"`
	}
	custom := s.customLabels()
	var out []row
	for _, name := range s.mapNames() {
		t, err := s.load(name)
		if err != nil {
			continue
		}
		for _, v := range s.views(t) {
			out = append(out, row{Map: t.info.Title, Partition: v.Partition, Internal: v.Internal,
				Auto: s.autoLabel(t, v.Partition, v.Internal), Custom: custom[strconv.Itoa(v.Partition)]})
		}
	}
	writeJSON(w, out)
}

// autoLabel ermittelt den Namen einer Instanz vom Server: Anzeigename aus den
// Instanz-Einstellungen, sonst PvP/PvE nach dem PvP-Schalter der Instanz.
func (s *Server) autoLabel(t *terrain, partition int, internal string) string {
	key := fmt.Sprintf("%s/%d", t.info.Source, partition)
	if v, ok := s.labelCache.Load(key); ok {
		return v.(string)
	}
	lp := s.lp()
	if lp == nil {
		return internal
	}
	values := func(scope string) map[string]string {
		c := lp.get(fmt.Sprintf("/api/maps/user-settings/values?scope=%s&map=%s&partitionId=%d",
			scope, url.QueryEscape(t.info.Source), partition), 10*time.Minute)
		out := map[string]string{}
		if c.status != http.StatusOK {
			return out
		}
		var doc struct {
			Stdout string `json:"stdout"`
		}
		json.Unmarshal(c.body, &doc)
		for _, l := range strings.Split(doc.Stdout, "\n") {
			if k, v, ok := strings.Cut(l, "\t"); ok {
				out[k] = strings.TrimSpace(v)
			}
		}
		return out
	}
	label := cleanLabel(values("partitionEngine")["server_display_name"], t.info.Title)
	if label == "" {
		switch strings.ToLower(values("partition")["partition_pvp_enabled"]) {
		case "true":
			label = "PvP (" + internal + ")"
		case "false":
			label = "PvE (" + internal + ")"
		default:
			label = internal
		}
	}
	s.labelCache.Store(key, label)
	return label
}

// cleanLabel kürzt „Deep Desert PvP“ zu „PvP“ und vereinheitlicht PVE/PVP.
func cleanLabel(l, mapTitle string) string {
	l = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(l), mapTitle))
	switch strings.ToUpper(l) {
	case "PVE":
		return "PvE"
	case "PVP":
		return "PvP"
	}
	return l
}

// partitionLabel: eigener Name vor automatischem Namen.
func (s *Server) partitionLabel(t *terrain, partition int, internal string) string {
	if v := s.customLabels()[strconv.Itoa(partition)]; v != "" {
		return v
	}
	if lp := s.lp(); lp != nil {
		if v := lp.cfg.Partitions[strconv.Itoa(partition)]; v != "" {
			return v
		}
	}
	return s.autoLabel(t, partition, internal)
}

// shortNetError verkürzt Netzwerkfehler auf eine knappe, sprachneutrale Ursache.
func shortNetError(err error) string {
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return "timeout"
	}
	var ue *url.Error
	if errors.As(err, &ue) {
		err = ue.Err
	}
	var oe *net.OpError
	if errors.As(err, &oe) && oe.Err != nil {
		msg := oe.Err.Error()
		if i := strings.LastIndex(msg, ": "); i >= 0 {
			msg = msg[i+2:]
		}
		return msg
	}
	return err.Error()
}
