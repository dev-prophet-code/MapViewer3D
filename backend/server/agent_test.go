package server

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"mapviewer3d/agent"
	"mapviewer3d/mapdata"
)

// fakeAgent liefert einen festen Stand und danach Positionsänderungen.
func fakeAgent(t *testing.T, snap agent.Snapshot, pos string) *httptest.Server {
	t.Helper()
	b, _ := json.Marshal(snap)
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/stream" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprintf(w, "event: snap\ndata: %s\n\n", b)
		w.(http.Flusher).Flush()
		time.Sleep(150 * time.Millisecond)
		fmt.Fprintf(w, "event: pos\ndata: %s\n\n", pos)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
}

func agentSnap() agent.Snapshot {
	return agent.Snapshot{Gen: 1, Sources: []agent.SrcInfo{
		{PID: 10, Map: "Survival_1", Partition: 1, Ready: true},  // PvE
		{PID: 11, Map: "Survival_1", Partition: 31, Ready: true}, // PvP
		{PID: 12, Map: "DeepDesert_1", Partition: 35, Ready: true},
	}, Objects: []agent.ObjOut{
		{ID: 1, Kind: "worm", Class: "BP_Crea_SandwormArrakis_C", Src: 0, X: 100, Y: 200, Z: 5},
		{ID: 2, Kind: "worm", Class: "BP_Crea_SandwormArrakis_C", Src: 1, X: 300, Y: 400, Z: 5},
		{ID: 3, Kind: "player", Class: "BP_Player_C", Src: 0, X: 1, Y: 2, Z: 3},
		{ID: 4, Kind: "npc", Class: "BP_Npc_SoldierBase_Character_Baked_C", Src: 2, X: 7, Y: 8, Z: 9},
	}}
}

func testServer(t *testing.T, src string) *Server {
	t.Helper()
	data := t.TempDir()
	dir := filepath.Join(data, "hagga")
	os.MkdirAll(dir, 0o755)
	meta, _ := json.Marshal(mapdata.Meta{Name: "hagga", Source: src, Width: 2, Height: 2, Spacing: 100})
	os.WriteFile(filepath.Join(dir, mapdata.FileMeta), meta, 0o644)
	os.WriteFile(filepath.Join(dir, mapdata.FileHeight), make([]byte, 8), 0o644)
	return New(data, t.TempDir(), t.TempDir(), nil)
}

func waitAgent(t *testing.T, s *Server) {
	t.Helper()
	for i := 0; i < 100; i++ {
		if l := s.agentLink(); l != nil {
			l.mu.RLock()
			n := len(l.objs)
			l.mu.RUnlock()
			if n > 0 {
				return
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("Agent-Verbindung kommt nicht zustande")
}

func getView(t *testing.T, s *Server, url string) agentView {
	t.Helper()
	rec := httptest.NewRecorder()
	s.mux.ServeHTTP(rec, httptest.NewRequest("GET", url, nil))
	var v agentView
	if err := json.Unmarshal(rec.Body.Bytes(), &v); err != nil {
		t.Fatalf("%s: %v: %s", url, err, rec.Body.String())
	}
	return v
}

func ids(v agentView) string {
	var out []string
	for _, r := range v.Rows {
		out = append(out, fmt.Sprint(r.ID))
	}
	return strings.Join(out, ",")
}

// Spieler gehen nie hinaus; die Karte filtert nach Kartenname; -partition grenzt weiter ein.
func TestAgentSnapshotFilter(t *testing.T) {
	a := fakeAgent(t, agentSnap(), `{"gen":1,"t":1,"d":[[1,111,222,6]],"r":[]}`)
	defer a.Close()
	s := testServer(t, "Survival_1")
	if err := s.UseAgent(a.URL); err != nil {
		t.Fatal(err)
	}
	defer s.StopAgent()
	waitAgent(t, s)
	v := getView(t, s, "/api/agent/hagga")
	if !v.Connected || ids(v) != "1,2" && ids(v) != "2,1" {
		t.Fatalf("Hagga ohne Spieler: %s (verbunden %v)", ids(v), v.Connected)
	}
	if v := getView(t, s, "/api/agent/hagga?partition=31"); ids(v) != "2" {
		t.Fatalf("Partition 31: %s", ids(v))
	}
}

// Im öffentlichen Betrieb gehen nur freigegebene PvE-Partitionen hinaus.
func TestAgentPublicOnlyPvE(t *testing.T) {
	a := fakeAgent(t, agentSnap(), `{"gen":1,"t":1,"d":[],"r":[]}`)
	defer a.Close()
	s := testServer(t, "Survival_1")
	s.UseAgent(a.URL)
	defer s.StopAgent()
	s.SetPublic(&PublicConfig{Partitions: []int{1}, ModeSource: "http://127.0.0.1:1/x"})
	s.public.mu.Lock()
	s.public.allowed = map[int]bool{1: true}
	s.public.checked = time.Now()
	s.public.mu.Unlock()
	waitAgent(t, s)
	if v := getView(t, s, "/api/agent/hagga"); ids(v) != "1" {
		t.Fatalf("öffentlich: erwartet nur Partition 1 (Objekt 1), bekam %q", ids(v))
	}
	// Ohne bestätigtes PvE: nichts
	s.public.mu.Lock()
	s.public.allowed = map[int]bool{}
	s.public.mu.Unlock()
	if v := getView(t, s, "/api/agent/hagga"); len(v.Rows) != 0 {
		t.Fatalf("ohne PvE-Bestätigung darf nichts hinausgehen: %q", ids(v))
	}
}

// Der Strom liefert erst den Stand, dann nur Änderungen bekannter Objekte.
func TestAgentStream(t *testing.T) {
	a := fakeAgent(t, agentSnap(), `{"gen":1,"t":5,"d":[[1,111,222,6],[4,1,1,1]],"r":[2]}`)
	defer a.Close()
	s := testServer(t, "Survival_1")
	s.UseAgent(a.URL)
	defer s.StopAgent()
	waitAgent(t, s)
	ts := httptest.NewServer(s)
	defer ts.Close()
	resp, err := http.Get(ts.URL + "/api/agent/hagga/stream")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if ct := resp.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("Content-Type %q", ct)
	}
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 1<<16), 1<<20)
	var name string
	got := map[string]string{}
	deadline := time.After(5 * time.Second)
	done := make(chan struct{})
	go func() {
		defer close(done)
		for sc.Scan() {
			l := sc.Text()
			if strings.HasPrefix(l, "event:") {
				name = strings.TrimSpace(l[6:])
			} else if strings.HasPrefix(l, "data:") {
				got[name] = l[5:]
				if name == "pos" {
					return
				}
			}
		}
	}()
	select {
	case <-done:
	case <-deadline:
		t.Fatalf("kein pos-Ereignis, bekam %v", got)
	}
	if !strings.Contains(got["snap"], `"i":1`) || strings.Contains(got["snap"], `"i":3`) || strings.Contains(got["snap"], `"i":4`) {
		t.Fatalf("snap: %s", got["snap"])
	}
	// Objekt 4 gehört zu DeepDesert und ist für diese Karte unbekannt: nicht in der Änderung
	if !strings.Contains(got["pos"], "[1,111,222,6]") || strings.Contains(got["pos"], "[4,") || !strings.Contains(got["pos"], `"r":[2]`) {
		t.Fatalf("pos: %s", got["pos"])
	}
}

func TestAgentAddress(t *testing.T) {
	s := &Server{}
	for _, bad := range []string{"", "ftp://x:1", "127.0.0.1:8796", "http://"} {
		if err := s.UseAgent(bad); err == nil {
			t.Errorf("%q muss abgelehnt werden", bad)
		}
	}
}
