package server

import (
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
func (s *Server) adminAllowed(r *http.Request) bool {
	if s.RemoteSetup {
		return true
	}
	// Über einen Reverse-Proxy (nginx …) kommt alles von 127.0.0.1; solche
	// Anfragen gelten immer als entfernt.
	for _, h := range []string{"Forwarded", "X-Forwarded-For", "X-Real-Ip"} {
		if r.Header.Get(h) != "" {
			return false
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return false
	}
	ip := net.ParseIP(host)
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
	writeJSON(w, map[string]any{"configured": ok && s.lp() != nil, "stored": ok, "server": host, "fingerprint": fp, "admin": admin})
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
		if port <= 0 {
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

// checkConsole prüft Erreichbarkeit und Token an der Kartenliste der Console.
func checkConsole(base, token string) error {
	req, _ := http.NewRequest(http.MethodGet, base+"/api/map/partitions", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
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
	base, _, err := normalizeServer(in.Server, in.Port)
	if err != nil {
		failErr(w, http.StatusBadRequest, err)
		return
	}
	if err := checkConsole(base, in.Token); err != nil {
		failErr(w, http.StatusBadGateway, err)
		return
	}
	if err := s.store.Save(secure.Credentials{APIBase: base, Token: in.Token}); err != nil {
		fail(w, http.StatusInternalServerError, "save_failed", err.Error())
		return
	}
	s.setLive(&LiveConfig{APIBase: base, Token: in.Token})
	s.clearServerCaches()
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
	s.setLive(nil)
	s.clearServerCaches()
	os.Remove(s.labelsFile())
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

func (s *Server) labelsFile() string { return filepath.Join(s.stateDir, "instance-names.json") }

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
	entries, _ := os.ReadDir(s.dataDir)
	for _, e := range entries {
		t, err := s.load(e.Name())
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
