package agent

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Hub verteilt Ereignisse an alle verbundenen Clients (SSE).
type Hub struct {
	mu   sync.Mutex
	subs map[chan []byte]struct{}
	last []byte // letzter Schnappschuss für neue Clients
}

func newHub() *Hub { return &Hub{subs: map[chan []byte]struct{}{}} }

func event(name string, v any) []byte {
	b, _ := json.Marshal(v)
	return []byte(fmt.Sprintf("event: %s\ndata: %s\n\n", name, b))
}

func (h *Hub) publishSnap(s Snapshot) {
	ev := event("snap", s)
	h.mu.Lock()
	h.last = ev
	h.mu.Unlock()
	h.broadcast(ev)
}

func (h *Hub) publishPos(gen uint64, t time.Time, delta [][4]float64, gone []uint32) {
	if delta == nil {
		delta = [][4]float64{}
	}
	if gone == nil {
		gone = []uint32{}
	}
	h.broadcast(event("pos", map[string]any{"gen": gen, "t": t.UnixMilli(), "d": delta, "r": gone}))
}

func (h *Hub) broadcast(ev []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.subs {
		select {
		case c <- ev:
		default: // Client liest nicht mehr: abhängen
			delete(h.subs, c)
			close(c)
		}
	}
}

func (h *Hub) subscribe() (chan []byte, []byte) {
	c := make(chan []byte, 256)
	h.mu.Lock()
	h.subs[c] = struct{}{}
	last := h.last
	h.mu.Unlock()
	return c, last
}

func (h *Hub) unsubscribe(c chan []byte) {
	h.mu.Lock()
	if _, ok := h.subs[c]; ok {
		delete(h.subs, c)
		close(c)
	}
	h.mu.Unlock()
}

// Handler ist die HTTP-Schnittstelle (nur lokal gedacht):
//
//	GET /healthz      Zustand der Prozesse
//	GET /api/objects  voller Schnappschuss (?kinds=worm,vehicle,npc,civilian)
//	GET /stream       SSE: "snap" (voller Stand) und "pos" (Positionsänderungen)
func (a *Agent) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		s := a.snapshot()
		ready := 0
		for _, src := range s.Sources {
			if src.Ready {
				ready++
			}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"ok": ready > 0, "gen": s.Gen, "ready": ready, "sources": s.Sources,
			"offsets": map[string]string{"blocks": fmt.Sprintf("0x%X", a.offsets().Blocks), "root": fmt.Sprintf("0x%X", a.offsets().Root), "pos": fmt.Sprintf("0x%X", a.offsets().Pos)}})
	})
	mux.HandleFunc("GET /api/objects", func(w http.ResponseWriter, r *http.Request) {
		s := a.snapshot()
		if k := r.URL.Query().Get("kinds"); k != "" {
			want := map[string]bool{}
			for _, x := range strings.Split(k, ",") {
				want[x] = true
			}
			kept := s.Objects[:0]
			for _, o := range s.Objects {
				if want[o.Kind] {
					kept = append(kept, o)
				}
			}
			s.Objects = kept
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		json.NewEncoder(w).Encode(s)
	})
	mux.HandleFunc("GET /stream", a.stream)
	return mux
}

func (a *Agent) stream(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "kein Streaming", http.StatusInternalServerError)
		return
	}
	rc := http.NewResponseController(w)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	c, last := a.hub.subscribe()
	defer a.hub.unsubscribe(c)
	write := func(b []byte) bool {
		rc.SetWriteDeadline(time.Now().Add(10 * time.Second)) // ein stehender Client darf nicht blockieren
		if _, err := w.Write(b); err != nil {
			return false
		}
		fl.Flush()
		return true
	}
	if last == nil {
		last = event("snap", a.snapshot())
	}
	if !write(last) {
		return
	}
	keep := time.NewTicker(20 * time.Second)
	defer keep.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case ev, ok := <-c:
			if !ok || !write(ev) {
				return
			}
		case <-keep.C:
			if !write([]byte(": keepalive\n\n")) {
				return
			}
		}
	}
}
