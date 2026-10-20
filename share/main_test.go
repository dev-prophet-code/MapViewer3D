package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const (
	svcKey     = "dak_servicekey_0123456789"
	otherKey   = "dak_otheradmin_0123456789"
	limitedKey = "dak_limited_0123456789"
	noMapsKey  = "dak_nomaps_0123456789"
)

type fixture struct {
	t       *testing.T
	gw      *gateway
	srv     *httptest.Server
	up      *httptest.Server
	secret  string
	hits    atomic.Int64
	headers chan http.Header
	events  chan string // raw upstream stream blocks to emit
}

func newFixture(t *testing.T) *fixture {
	f := &fixture{t: t, headers: make(chan http.Header, 64), events: make(chan string, 64)}
	f.up = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.hits.Add(1)
		select {
		case f.headers <- r.Header.Clone():
		default:
		}
		got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		switch got {
		case svcKey, otherKey:
		case limitedKey:
			if r.URL.Path == "/api/map/players" || strings.HasPrefix(r.URL.Path, "/api/realtime/") {
				http.Error(w, `{"error":"forbidden"}`, 403)
				return
			}
		case noMapsKey:
			http.Error(w, `{"error":"forbidden"}`, 403)
			return
		default:
			http.Error(w, `{"error":"secret console detail"}`, 401)
			return
		}
		if r.Method != "GET" {
			t.Errorf("upstream got %s", r.Method)
		}
		switch r.URL.Path {
		case "/api/map/partitions":
			io.WriteString(w, `{"rows":[{"map":"Survival_1","alive":true,"partition_id":7,"name":"P7","server_id":"secret-id"}]}`)
		case "/api/map/status":
			io.WriteString(w, `{"maps":{"stdout":"Survival_1 Current: 1 Assigned: 1","stderr":"x"},"secret":1}`)
		case "/api/map/markers":
			io.WriteString(w, `{"maps":{"HaggaBasin":{"image":"/images/maps/hagga.webp","minX":1,"maxX":2,"minY":3,"maxY":4,"flipY":true,"admin":"x"}},"coriolisLayout":8,"rows":[{"fls_id":"leak"}]}`)
		case "/api/map/overlays":
			io.WriteString(w, `{"capabilities":{},"rows":[
			 {"id":1,"type":"player","name":"Anna","online_status":"online","fls_id":"FLS1","funcom_id":"FC1","account_id":5,"action_player_id":"A","map":"Survival_1","x":1,"y":2,"z":3},
			 {"id":2,"type":"vehicle","name":"Buggy","owner_name":"Anna","map":"Survival_1","partition_id":7,"x":4,"y":5,"z":6,"subtype":"buggy","sectorX":2},
			 {"id":3,"type":"base","name":"Home","base_type":"x","owner_name":"Bob","owner_account":9,"x":7,"y":8,"z":9}]}`)
		case "/api/map/players":
			io.WriteString(w, `{"rows":[{"id":1,"type":"player","name":"Anna","online_status":"online","fls_id":"FLS1","funcom_id":"FC1","account_id":5,"x":1,"y":2,"z":3}]}`)
		case "/api/maps/user-settings/values":
			io.WriteString(w, `{"stdout":"server_password\thunter2\nserver_display_name\tMy Server\npartition_pvp_enabled\tfalse\nrcon_password\tx\n"}`)
		case "/api/bases/12/export":
			io.WriteString(w, `{"name":"Home","owner":"Bob","x":1,"y":2,"z":3,"instances":[{"building_type":"Wall","x":1,"y":2,"z":3,"rotation":90,"owner_id":4}],"placeables":[{"building_type":"Chest","x":1,"y":2,"z":3,"rx":0,"ry":0,"rz":0,"inventory":[{"item":"Spice"}]}]}`)
		case "/api/realtime/healthz":
			io.WriteString(w, `{"available":true,"version":"1","sources":[{"pid":123}]}`)
		case "/images/maps/hagga.webp":
			w.Header().Set("Content-Type", "image/webp")
			io.WriteString(w, "IMG")
		case "/api/realtime/stream":
			w.Header().Set("Content-Type", "text/event-stream")
			fl := w.(http.Flusher)
			fl.Flush()
			for {
				select {
				case ev := <-f.events:
					io.WriteString(w, ev)
					fl.Flush()
				case <-r.Context().Done():
					return
				}
			}
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(f.up.Close)
	dir := t.TempDir()
	web := filepath.Join(dir, "web")
	os.MkdirAll(filepath.Join(web, "js"), 0o755)
	os.WriteFile(filepath.Join(web, "index.html"), []byte("<html>viewer</html>"), 0o644)
	os.WriteFile(filepath.Join(web, "js", "main.js"), []byte("//js"), 0o644)
	os.WriteFile(filepath.Join(web, ".secret"), []byte("hidden"), 0o644)
	os.WriteFile(filepath.Join(dir, "outside.txt"), []byte("outside"), 0o644)
	os.WriteFile(filepath.Join(dir, "service-key"), []byte(svcKey+"\n"), 0o600)
	cfg, err := loadConfig(func(k string) string {
		return map[string]string{"MV_SHARE_STATE": dir, "MV_SHARE_WEB": web, "MV_SHARE_UPSTREAM": f.up.URL,
			"MV_SHARE_ADMIN_ORIGINS": "https://console.example.org"}[k]
	})
	if err != nil {
		t.Fatal(err)
	}
	f.secret, _, err = loadOrCreateAdminSecret(dir)
	if err != nil {
		t.Fatal(err)
	}
	f.gw, err = newGateway(cfg, f.secret)
	if err != nil {
		t.Fatal(err)
	}
	f.srv = httptest.NewServer(f.gw)
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fixture) do(method, path string, body any, hdr map[string]string) (int, string, http.Header) {
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = strings.NewReader(string(b))
	}
	req, _ := http.NewRequest(method, f.srv.URL+path, rd)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		f.t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b), resp.Header
}

func (f *fixture) admin(method, path string, body any) (int, string) {
	code, b, _ := f.do(method, "/share-admin/"+path, body, map[string]string{"Authorization": "Bearer " + f.secret})
	return code, b
}

func (f *fixture) newLink(req createReq) (token, id string) {
	code, b := f.admin("POST", "links", req)
	if code != 201 {
		f.t.Fatalf("create: %d %s", code, b)
	}
	var out struct {
		Token string
		Link  linkView
		Path  string
	}
	json.Unmarshal([]byte(b), &out)
	return out.Token, out.Link.ID
}

func TestTokenFormatAndUniqueness(t *testing.T) {
	f := newFixture(t)
	seen := map[string]bool{}
	for i := 0; i < 20; i++ {
		tok, _ := f.newLink(createReq{Never: true})
		if !tokenPattern.MatchString(tok) || seen[tok] {
			t.Fatalf("bad or repeated token %q", tok)
		}
		seen[tok] = true
	}
}

func TestOnlyHashIsStored(t *testing.T) {
	f := newFixture(t)
	tok, _ := f.newLink(createReq{Never: true, Label: "x"})
	b, _ := os.ReadFile(filepath.Join(f.gw.cfg.State, "links.json"))
	if strings.Contains(string(b), tok) || strings.Contains(string(b), tok[len(tokenPrefix):]) {
		t.Fatal("token stored in clear")
	}
	if st, _ := os.Stat(filepath.Join(f.gw.cfg.State, "links.json")); st.Mode().Perm() != 0o600 {
		t.Fatal("links.json permissions")
	}
	// survives a restart
	st2, err := newStore(f.gw.cfg.State)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := st2.lookup(tok); !ok {
		t.Fatal("link lost after reload")
	}
}

func TestForgedAndWrongTokens(t *testing.T) {
	f := newFixture(t)
	tok, _ := f.newLink(createReq{Never: true})
	flip := tok[:len(tok)-1] + map[bool]string{true: "A", false: "B"}[tok[len(tok)-1] != 'A']
	for _, bad := range []string{flip, "mvs_" + strings.Repeat("A", 43), "", "x", tok + "x", tok[:20], strings.ToUpper(tok), "dak_servicekey_0123456789", "../" + tok} {
		code, _, _ := f.do("GET", "/s/"+bad+"/", nil, nil)
		if code != 404 {
			t.Fatalf("token %q: status %d, want 404", bad, code)
		}
	}
	if code, _, _ := f.do("GET", "/s/"+tok+"/", nil, nil); code != 200 {
		t.Fatal("valid token refused")
	}
}

func TestExpiryAndRevocation(t *testing.T) {
	f := newFixture(t)
	tok, id := f.newLink(createReq{Seconds: 3600})
	if code, _, _ := f.do("GET", "/s/"+tok+"/", nil, nil); code != 200 {
		t.Fatal("fresh link refused")
	}
	// one hour and a second later
	f.gw.st.now = func() time.Time { return time.Now().Add(3601 * time.Second) }
	if code, _, _ := f.do("GET", "/s/"+tok+"/", nil, nil); code != 404 {
		t.Fatal("expired link accepted")
	}
	f.gw.st.now = time.Now
	if code, _, _ := f.do("GET", "/s/"+tok+"/", nil, nil); code != 200 {
		t.Fatal("still valid again")
	}
	if code, b := f.admin("DELETE", "links/"+id, nil); code != 200 {
		t.Fatal(b)
	}
	if code, _, _ := f.do("GET", "/s/"+tok+"/", nil, nil); code != 404 {
		t.Fatal("revoked link accepted")
	}
	if _, b := f.admin("GET", "links", nil); strings.Contains(b, id) {
		t.Fatalf("revoked link still listed: %s", b)
	}
	if code, _ := f.admin("DELETE", "links/"+id, nil); code != 404 {
		t.Fatal("revoking twice must say 404")
	}
	st2, _ := newStore(f.gw.cfg.State)
	if _, ok := st2.lookup(tok); ok {
		t.Fatal("revoked link is back after a restart")
	}
	if code, _ := f.admin("POST", "links", createReq{Seconds: 5}); code != 400 {
		t.Fatal("too short duration accepted")
	}
	if code, _ := f.admin("POST", "links", createReq{}); code != 400 {
		t.Fatal("link without duration and without never accepted")
	}
	if code, _ := f.admin("POST", "links", createReq{Seconds: 10 * 365 * 24 * 3600}); code != 400 {
		t.Fatal("absurd duration accepted")
	}
}

func TestAdminAuthAndCORS(t *testing.T) {
	f := newFixture(t)
	for _, h := range []map[string]string{nil, {"Authorization": "Bearer wrong"}, {"Authorization": "Bearer dak_notaknownkey_0123456789"}, {"Authorization": f.secret}} {
		if code, _, _ := f.do("GET", "/share-admin/links", nil, h); code != 401 {
			t.Fatalf("admin with %v: %d", h, code)
		}
	}
	if code, _, _ := f.do("GET", "/share-admin/links", nil, map[string]string{"Authorization": "Bearer " + f.secret, "Origin": "https://evil.example"}); code != 403 {
		t.Fatalf("foreign origin: %d", code)
	}
	code, _, h := f.do("OPTIONS", "/share-admin/links", nil, map[string]string{"Origin": "https://console.example.org"})
	if h.Get("Access-Control-Allow-Private-Network") != "" {
		t.Fatal("private network access granted without being asked")
	}
	if code != 204 || h.Get("Access-Control-Allow-Origin") != "https://console.example.org" || h.Get("Access-Control-Allow-Credentials") != "" {
		t.Fatalf("preflight: %d %v", code, h)
	}
	if code, _, _ := f.do("GET", "/share-admin/links", nil, map[string]string{"Authorization": "Bearer " + f.secret, "Origin": "https://console.example.org"}); code != 200 {
		t.Fatal("allowed origin refused")
	}
	// a link token is not an admin secret
	tok, _ := f.newLink(createReq{Never: true})
	if code, _, _ := f.do("GET", "/share-admin/links", nil, map[string]string{"Authorization": "Bearer " + tok}); code != 401 {
		t.Fatal("token works as admin secret")
	}
	if code, _, _ := f.do("GET", "/s/"+tok+"/share-admin/links", nil, map[string]string{"Authorization": "Bearer " + f.secret}); code == 200 {
		t.Fatal("admin API reachable through a link")
	}
}

func TestBruteForceBlocks(t *testing.T) {
	f := newFixture(t)
	var last int
	for i := 0; i < 30; i++ {
		last, _, _ = f.do("GET", "/s/mvs_"+strings.Repeat("B", 43)+"/", nil, nil)
	}
	if last != 429 {
		t.Fatalf("no block after repeated invalid tokens: %d", last)
	}
	if code, _ := f.admin("GET", "links", nil); code != 429 {
		t.Fatalf("a blocked address may still use the admin API: %d", code)
	}
}

func TestAllowListAndMethods(t *testing.T) {
	f := newFixture(t)
	tok, _ := f.newLink(createReq{Never: true, Bases: true, Realtime: true})
	base := "/s/" + tok
	for _, p := range []string{"/api/auth/login", "/api/settings", "/api/players", "/api/server/restart", "/api/addons/installed", "/api/map/storage",
		"/api/map/services", "/api/bases/12/export-backup", "/api/bases/x/export", "/api/maps/userengine", "/api/realtime/objects", "/images/maps/../../etc/passwd",
		"/images/maps/x.sh", "/api/map/overlays/x"} {
		code, _, _ := f.do("GET", base+p, nil, nil)
		if code == 200 {
			t.Fatalf("%s reachable", p)
		}
	}
	if code, _, _ := f.do("POST", base+"/api/map/status", nil, nil); code != 405 {
		t.Fatal("POST accepted")
	}
	for _, q := range []string{"?map=../x", "?map=A&evil=1", "?map=A&map=B", "?map=A%0d%0aX"} {
		if code, _, _ := f.do("GET", base+"/api/map/overlays"+q, nil, nil); code != 400 {
			t.Fatalf("query %q: %d", q, code)
		}
	}
	if code, _, _ := f.do("GET", base+"/api/maps/user-settings/values?scope=secrets&map=A", nil, nil); code != 400 {
		t.Fatal("arbitrary settings scope")
	}
}

func TestAnswersAreCleaned(t *testing.T) {
	f := newFixture(t)
	none, _ := f.newLink(createReq{Never: true})
	all, _ := f.newLink(createReq{Never: true, Players: true, Bases: true, Realtime: true})

	get := func(tok, p string) (int, string) {
		c, b, _ := f.do("GET", "/s/"+tok+p, nil, nil)
		return c, b
	}
	forbidden := []string{"FLS1", "FC1", "account_id", "action_player_id", "owner_account", "secret", "server_id", "hunter2", "rcon", "Spice", "pid", "inventory", "owner_id", svcKey}
	check := func(name, body string) {
		for _, w := range forbidden {
			if strings.Contains(body, w) {
				t.Errorf("%s leaks %q: %s", name, w, body)
			}
		}
	}

	for _, p := range []string{"/api/map/partitions", "/api/map/status", "/api/map/markers?map=HaggaBasin", "/api/map/overlays?map=Survival_1", "/api/map/players?map=Survival_1",
		"/api/maps/user-settings/values?scope=partitionEngine&map=Survival_1&partitionId=7", "/api/bases/12/export", "/api/realtime/healthz"} {
		for _, tok := range []string{none, all} {
			_, body := get(tok, p)
			check(p, body)
		}
	}
	// players off: no player rows, no owner names, empty players feed
	_, b := get(none, "/api/map/overlays?map=Survival_1")
	if strings.Contains(b, "Anna") || strings.Contains(b, "Bob") || !strings.Contains(b, "Buggy") || !strings.Contains(b, "sectorX") {
		t.Fatalf("overlays without players: %s", b)
	}
	if code, b := get(none, "/api/map/players?map=Survival_1"); code != 200 || strings.Contains(b, "Anna") {
		t.Fatalf("players feed without option: %d %s", code, b)
	}
	if code, b := get(none, "/api/link"); code != 200 || !strings.Contains(b, `"players":false`) || !strings.Contains(b, `"expires":0`) || strings.Contains(b, "hash") {
		t.Fatalf("link info: %d %s", code, b)
	}
	if code, _ := get(none, "/api/bases/12/export"); code != 404 {
		t.Fatalf("bases without option: %d", code)
	}
	if code, _ := get(none, "/api/realtime/healthz"); code != 403 {
		t.Fatalf("realtime without option: %d", code)
	}
	// players on: names yes, ids no
	_, b = get(all, "/api/map/overlays?map=Survival_1")
	if !strings.Contains(b, "Anna") || !strings.Contains(b, "online_status") {
		t.Fatalf("overlays with players: %s", b)
	}
	_, b = get(all, "/api/maps/user-settings/values?scope=partitionEngine&map=Survival_1&partitionId=7")
	if !strings.Contains(b, "My Server") || !strings.Contains(b, "partition_pvp_enabled") {
		t.Fatalf("settings: %s", b)
	}
	_, b = get(all, "/api/bases/12/export")
	if !strings.Contains(b, "Wall") || !strings.Contains(b, "Chest") {
		t.Fatalf("base: %s", b)
	}
	_, b = get(all, "/api/map/markers?map=HaggaBasin")
	if !strings.Contains(b, `"image":"/images/maps/hagga.webp"`) || !strings.Contains(b, `"coriolisLayout":8`) {
		t.Fatalf("markers: %s", b)
	}
	if code, b := get(all, "/images/maps/hagga.webp"); code != 200 || b != "IMG" {
		t.Fatalf("image: %d", code)
	}
}

func TestUpstreamRequestsCarryOnlyTheServiceKey(t *testing.T) {
	f := newFixture(t)
	tok, _ := f.newLink(createReq{Never: true})
	f.do("GET", "/s/"+tok+"/api/map/status", nil, map[string]string{"Cookie": "console_session=ADMIN", "Authorization": "Bearer dak_visitor_supplied_12345", "X-Forwarded-For": "1.2.3.4"})
	h := <-f.headers
	if h.Get("Authorization") != "Bearer "+svcKey || h.Get("Cookie") != "" || h.Get("X-Forwarded-For") != "" {
		t.Fatalf("upstream headers: %v", h)
	}
}

func TestBadServiceKeyIsNotTheVisitorsProblem(t *testing.T) {
	f := newFixture(t)
	tok, _ := f.newLink(createReq{Never: true})
	os.WriteFile(f.gw.cfg.KeyFile, []byte("dak_otherkey_0123456789\n"), 0o600)
	f.gw.keyStamp = time.Time{}
	code, b, _ := f.do("GET", "/s/"+tok+"/api/map/status", nil, nil)
	if code != 503 || strings.Contains(b, "secret console detail") {
		t.Fatalf("%d %s", code, b)
	}
	os.Remove(f.gw.cfg.KeyFile)
	f.gw.keyStamp = time.Time{}
	if code, _, _ := f.do("GET", "/s/"+tok+"/api/map/status", nil, nil); code != 503 {
		t.Fatal("no key must answer 503")
	}
}

func TestCacheShieldsTheConsole(t *testing.T) {
	f := newFixture(t)
	tok, _ := f.newLink(createReq{Never: true})
	before := f.hits.Load()
	for i := 0; i < 40; i++ {
		f.do("GET", "/s/"+tok+"/api/map/status", nil, nil)
	}
	if n := f.hits.Load() - before; n > 2 {
		t.Fatalf("console asked %d times for 40 visitors", n)
	}
}

func TestStaticFiles(t *testing.T) {
	f := newFixture(t)
	tok, _ := f.newLink(createReq{Never: true})
	code, b, h := f.do("GET", "/s/"+tok+"/", nil, nil)
	if code != 200 || b != "<html>viewer</html>" || !strings.Contains(h.Get("Content-Security-Policy"), "default-src 'none'") || h.Get("Referrer-Policy") != "no-referrer" {
		t.Fatalf("index: %d %v", code, h)
	}
	if code, _, _ := f.do("GET", "/s/"+tok+"/js/main.js", nil, nil); code != 200 {
		t.Fatal("js")
	}
	for _, p := range []string{"/.secret", "/js/", "/../outside.txt", "/%2e%2e/outside.txt", "/js/../../outside.txt", "/nope"} {
		if code, b, _ := f.do("GET", "/s/"+tok+p, nil, nil); code == 200 && (b == "hidden" || b == "outside") {
			t.Fatalf("%s served %q", p, b)
		}
	}
	nr := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	if resp, err := nr.Get(f.srv.URL + "/s/" + tok); err != nil || resp.StatusCode != 308 || resp.Header.Get("Location") != "/s/"+tok+"/" {
		t.Fatalf("redirect: %v %v", resp, err)
	}
}

func readStream(t *testing.T, url string) (*bufio.Reader, func()) {
	resp, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 200 {
		t.Fatalf("stream status %d", resp.StatusCode)
	}
	return bufio.NewReader(resp.Body), func() { resp.Body.Close() }
}

func nextBlock(t *testing.T, r *bufio.Reader) string {
	done := make(chan string, 1)
	go func() {
		var sb strings.Builder
		for {
			l, err := r.ReadString('\n')
			if err != nil {
				done <- sb.String()
				return
			}
			if l == "\n" {
				if sb.Len() > 0 && !strings.HasPrefix(sb.String(), ":") {
					done <- sb.String()
					return
				}
				sb.Reset()
				continue
			}
			sb.WriteString(l)
		}
	}()
	select {
	case b := <-done:
		return b
	case <-time.After(5 * time.Second):
		t.Fatal("no stream block")
		return ""
	}
}

func TestRealtimeStreamFanOutAndPlayerFilter(t *testing.T) {
	f := newFixture(t)
	tok, id := f.newLink(createReq{Never: true, Realtime: true})
	noRT, _ := f.newLink(createReq{Never: true})
	if code, _, _ := f.do("GET", "/s/"+noRT+"/api/realtime/stream", nil, nil); code != 403 {
		t.Fatal("stream without option")
	}
	f.events <- "event: snap\ndata: {\"gen\":1,\"t\":5,\"sources\":[{\"map\":\"Survival_1\",\"partition\":7}],\"objects\":[{\"i\":10,\"k\":\"worm\",\"s\":0,\"x\":1,\"y\":2,\"z\":3},{\"i\":11,\"k\":\"player\",\"s\":0,\"x\":9,\"y\":9,\"z\":9}]}\n\n"
	a, closeA := readStream(t, f.srv.URL+"/s/"+tok+"/api/realtime/stream")
	defer closeA()
	b1 := nextBlock(t, a)
	if !strings.Contains(b1, `"i":10`) || strings.Contains(b1, `"i":11`) || strings.Contains(b1, "player") {
		t.Fatalf("snapshot: %s", b1)
	}
	// a second visitor shares the upstream stream and gets the current state at once
	b, closeB := readStream(t, f.srv.URL+"/s/"+tok+"/api/realtime/stream")
	defer closeB()
	if b2 := nextBlock(t, b); !strings.Contains(b2, `"i":10`) {
		t.Fatalf("second visitor: %s", b2)
	}
	f.events <- ": keep-alive\n\n"
	f.events <- "event: pos\ndata: {\"gen\":1,\"t\":6,\"d\":[[10,100,200,300],[11,5,5,5]],\"r\":[]}\n\n"
	p := nextBlock(t, a)
	if !strings.Contains(p, "[10,100,200,300]") || strings.Contains(p, "[11,") {
		t.Fatalf("pos: %s", p)
	}
	if !strings.Contains(nextBlock(t, b), "[10,100,200,300]") {
		t.Fatal("fan-out")
	}
	// a late visitor sees the moved position in its snapshot
	c, closeC := readStream(t, f.srv.URL+"/s/"+tok+"/api/realtime/stream")
	defer closeC()
	if s := nextBlock(t, c); !strings.Contains(s, `"x":100`) {
		t.Fatalf("late snapshot: %s", s)
	}
	// one upstream stream for all of them
	// revoking the link ends open streams
	f.admin("DELETE", "links/"+id, nil)
	done := make(chan struct{})
	go func() {
		for {
			if _, err := a.ReadString('\n'); err != nil {
				close(done)
				return
			}
		}
	}()
	select {
	case <-done:
	case <-time.After(12 * time.Second):
		t.Fatal("stream of a revoked link stays open")
	}
}

func TestStatusReportsCapabilities(t *testing.T) {
	f := newFixture(t)
	code, b := f.admin("GET", "status", nil)
	if code != 200 {
		t.Fatal(b)
	}
	var st map[string]any
	json.Unmarshal([]byte(b), &st)
	if st["keyConfigured"] != true || st["maps"] != true || st["realtime"] != true || st["players"] != true {
		t.Fatalf("%v", st)
	}
	if strings.Contains(b, svcKey) {
		t.Fatal("status leaks the key")
	}
}

func TestConfigRefusesUnsafeSetups(t *testing.T) {
	env := func(m map[string]string) func(string) string { return func(k string) string { return m[k] } }
	if _, err := loadConfig(env(map[string]string{"MV_SHARE_ADDR": "0.0.0.0:8798"})); err == nil {
		t.Fatal("plain HTTP on a public address accepted")
	}
	if _, err := loadConfig(env(map[string]string{"MV_SHARE_ADDR": "0.0.0.0:8798", "MV_SHARE_ALLOW_PLAIN": "true"})); err != nil {
		t.Fatal(err)
	}
	if _, err := loadConfig(env(map[string]string{"MV_SHARE_UPSTREAM": "http://console.example.org:8088"})); err == nil {
		t.Fatal("service key over plain HTTP to a remote host accepted")
	}
	if _, err := loadConfig(env(map[string]string{"MV_SHARE_ADMIN_ORIGINS": "https://a.example/path"})); err == nil {
		t.Fatal("origin with path accepted")
	}
	if _, err := loadConfig(env(map[string]string{"MV_SHARE_CERT": "x"})); err == nil {
		t.Fatal("cert without key accepted")
	}
}

func TestLinkLimit(t *testing.T) {
	f := newFixture(t)
	for i := 0; i < maxLinks; i++ {
		if _, _, err := f.gw.st.create(linkOptions{}); err != nil {
			t.Fatal(i, err)
		}
	}
	if code, _ := f.admin("POST", "links", createReq{Never: true}); code != 409 {
		t.Fatalf("limit: %d", code)
	}
	_ = fmt.Sprint()
}

func TestCSPAllowsOnlyTheImportMapInline(t *testing.T) {
	html := []byte(`<html><script type="importmap">{"imports":{"three":"./t.js"}}</script><script src="a.js"></script><script type="module" src="b.js"></script></html>`)
	csp := cspFor(html)
	sum := sha256.Sum256([]byte(`{"imports":{"three":"./t.js"}}`))
	want := "'sha256-" + base64.StdEncoding.EncodeToString(sum[:]) + "'"
	if !strings.Contains(csp, want) || strings.Count(csp, "sha256-") != 1 {
		t.Fatalf("csp: %s", csp)
	}
	if strings.Contains(csp, "unsafe-eval") || strings.Contains(csp, "script-src 'unsafe-inline'") || !strings.Contains(csp, "frame-ancestors 'none'") {
		t.Fatalf("csp too loose: %s", csp)
	}
}

func (f *fixture) adminAs(key, method, path string, body any) (int, string) {
	code, b, _ := f.do(method, "/share-admin/"+path, body, map[string]string{"Authorization": "Bearer " + key})
	return code, b
}

func TestAdminWithTheConsoleKey(t *testing.T) {
	f := newFixture(t)
	if code, _ := f.adminAs(otherKey, "GET", "links", nil); code != 200 {
		t.Fatalf("valid console key: %d", code)
	}
	if code, _ := f.adminAs("dak_notaknownkey_0123456789", "GET", "links", nil); code != 401 {
		t.Fatalf("invalid key: %d", code)
	}
	if code, _ := f.adminAs(noMapsKey, "GET", "links", nil); code != 403 {
		t.Fatalf("key without maps: %d", code)
	}
	// a key can only offer what it can read itself
	if code, b := f.adminAs(limitedKey, "POST", "links", createReq{Never: true, Players: true}); code != 400 {
		t.Fatalf("players offered by a key without them: %d %s", code, b)
	}
	if code, b := f.adminAs(limitedKey, "POST", "links", createReq{Never: true, Realtime: true}); code != 400 {
		t.Fatalf("realtime offered by a key without it: %d %s", code, b)
	}
	if code, b := f.adminAs(limitedKey, "POST", "links", createReq{Never: true, Bases: true}); code != 201 {
		t.Fatalf("what the key can read: %d %s", code, b)
	}
	code, b := f.adminAs(limitedKey, "GET", "status", nil)
	if code != 200 || !strings.Contains(b, `"players":false`) || !strings.Contains(b, `"realtime":false`) || !strings.Contains(b, `"bases":true`) || !strings.Contains(b, "Realtime Data scope") {
		t.Fatalf("status for a limited key: %d %s", code, b)
	}
	// brute force on keys is counted like everything else
	var last int
	for i := 0; i < 30; i++ {
		last, _ = f.adminAs(fmt.Sprintf("dak_guess%020d", i), "GET", "links", nil)
	}
	if last != 429 {
		t.Fatalf("no block after repeated wrong keys: %d", last)
	}
}

func TestServiceKeyIsAdoptedOnlyWhenNeeded(t *testing.T) {
	f := newFixture(t)
	keyFile := f.gw.cfg.KeyFile
	read := func() string { b, _ := os.ReadFile(keyFile); return strings.TrimSpace(string(b)) }
	// a working service key is never replaced by a presented one
	f.adminAs(otherKey, "GET", "status", nil)
	if read() != svcKey {
		t.Fatalf("working key replaced: %q", read())
	}
	// no key stored yet: the first valid admin key is taken over
	os.Remove(keyFile)
	f.gw.keyStamp = time.Time{}
	f.gw.keyVal = ""
	code, b := f.adminAs(otherKey, "GET", "status", nil)
	if code != 200 || read() != otherKey || !strings.Contains(b, `"adopted":true`) {
		t.Fatalf("no adoption: %d %s %q", code, b, read())
	}
	if st, _ := os.Stat(keyFile); st.Mode().Perm() != 0o600 {
		t.Fatal("key file permissions")
	}
	// the stored key is rejected later (rotated): the next valid admin key replaces it
	os.WriteFile(keyFile, []byte("dak_revokedone_0123456789\n"), 0o600)
	f.gw.keyStamp = time.Time{}
	f.gw.keyVal = ""
	f.adminAs(svcKey, "GET", "status", nil)
	if read() != svcKey {
		t.Fatalf("rotated key not replaced: %q", read())
	}
	// links work with the adopted key
	tok, _ := f.newLink(createReq{Never: true})
	if code, _, _ := f.do("GET", "/s/"+tok+"/api/map/status", nil, nil); code != 200 {
		t.Fatalf("link after adoption: %d", code)
	}
}

func TestPreflightPrivateNetwork(t *testing.T) {
	f := newFixture(t)
	_, _, h := f.do("OPTIONS", "/share-admin/status", nil, map[string]string{"Origin": "https://console.example.org", "Access-Control-Request-Private-Network": "true"})
	if h.Get("Access-Control-Allow-Private-Network") != "true" {
		t.Fatalf("%v", h)
	}
	_, _, h = f.do("OPTIONS", "/share-admin/status", nil, map[string]string{"Origin": "https://evil.example", "Access-Control-Request-Private-Network": "true"})
	if h.Get("Access-Control-Allow-Private-Network") != "" {
		t.Fatal("granted to a foreign origin")
	}
}
