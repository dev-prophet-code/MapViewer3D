package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// The Console allows a few streams per API key. A share link can be opened by many people at once, so
// the gateway keeps ONE upstream stream, removes player objects once, keeps the current state, and fans
// the events out. A new visitor gets a snapshot built from that state, then the live events.

type subscriber struct {
	ch   chan []byte
	fail chan int // HTTP status when the upstream refuses (before or during the stream)
	once sync.Once
}

func (s *subscriber) deny(code int) { s.once.Do(func() { s.fail <- code }) }

type hub struct {
	mu      sync.Mutex
	gw      *gateway
	subs    map[*subscriber]struct{}
	cancel  context.CancelFunc
	running bool

	have    bool
	gen, t  any
	sources any
	objs    map[string]obj
	order   []string
	dropped map[string]bool
}

func newHub(gw *gateway) *hub {
	return &hub{gw: gw, subs: map[*subscriber]struct{}{}}
}

const maxSubscribers = 64

func (h *hub) subscribe() (*subscriber, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.subs) >= maxSubscribers {
		return nil, false
	}
	s := &subscriber{ch: make(chan []byte, 256), fail: make(chan int, 1)}
	h.subs[s] = struct{}{}
	if h.have {
		s.ch <- h.snapshotBlock()
	}
	if !h.running {
		ctx, cancel := context.WithCancel(context.Background())
		h.cancel, h.running = cancel, true
		go h.run(ctx)
	}
	return s, true
}

func (h *hub) unsubscribe(s *subscriber) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.subs, s)
	if len(h.subs) == 0 && h.cancel != nil {
		h.cancel()
		h.cancel, h.running, h.have = nil, false, false
	}
}

func block(name string, v any) []byte {
	b, _ := json.Marshal(v)
	return []byte("event: " + name + "\ndata: " + string(b) + "\n\n")
}

// must hold h.mu
func (h *hub) snapshotBlock() []byte {
	list := make([]any, 0, len(h.order))
	for _, id := range h.order {
		if o, ok := h.objs[id]; ok {
			list = append(list, o)
		}
	}
	return block("snap", obj{"gen": h.gen, "t": h.t, "sources": h.sources, "objects": list})
}

func (h *hub) broadcast(b []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for s := range h.subs {
		select {
		case s.ch <- b:
		default: // too slow: let it reconnect instead of holding everyone up
			delete(h.subs, s)
			s.deny(http.StatusServiceUnavailable)
		}
	}
}

func (h *hub) failAll(code int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for s := range h.subs {
		s.deny(code)
	}
}

func (h *hub) run(ctx context.Context) {
	backoff := time.Second
	for ctx.Err() == nil {
		code := h.connect(ctx)
		if ctx.Err() != nil {
			return
		}
		h.mu.Lock()
		h.have = false
		h.mu.Unlock()
		if code == http.StatusUnauthorized || code == http.StatusForbidden || code == http.StatusNotFound || code == http.StatusServiceUnavailable {
			h.failAll(code)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		if backoff < 30*time.Second {
			backoff *= 2
		}
	}
}

// connect reads one upstream stream until it ends. It returns the HTTP status if the Console refused.
func (h *hub) connect(ctx context.Context) int {
	req, err := h.gw.upstreamRequest(ctx, "/api/realtime/stream", "")
	if err != nil {
		return http.StatusServiceUnavailable
	}
	req.Header.Set("Accept", "text/event-stream")
	resp, err := h.gw.streamClient.Do(req)
	if err != nil {
		return 0
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return resp.StatusCode
	}
	if ctx.Err() != nil {
		return 0
	}
	h.mu.Lock()
	h.dropped = map[string]bool{}
	h.objs, h.order = map[string]obj{}, nil
	h.mu.Unlock()
	rd := bufio.NewReaderSize(resp.Body, 64<<10)
	idle := time.AfterFunc(65*time.Second, func() { resp.Body.Close() })
	defer idle.Stop()
	for {
		name, data, err := readBlock(rd)
		if err != nil {
			return 0
		}
		idle.Reset(65 * time.Second)
		if ctx.Err() != nil {
			return 0
		}
		h.handle(name, data)
	}
}

const maxBlock = 16 << 20

func readBlock(rd *bufio.Reader) (name, data string, err error) {
	var sb strings.Builder
	var total int
	for {
		line, err := rd.ReadString('\n')
		total += len(line)
		if total > maxBlock {
			return "", "", io.ErrShortBuffer
		}
		if err != nil {
			return "", "", err
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			if name != "" || sb.Len() > 0 {
				return name, sb.String(), nil
			}
			continue
		}
		switch {
		case strings.HasPrefix(line, ":"):
			// keep-alive comment: never forwarded
		case strings.HasPrefix(line, "event:"):
			name = strings.TrimSpace(line[6:])
		case strings.HasPrefix(line, "data:"):
			sb.WriteString(strings.TrimSpace(line[5:]))
		}
	}
}

func (h *hub) handle(name, data string) {
	v, err := decode([]byte(data))
	if err != nil {
		return
	}
	switch name {
	case "snap":
		h.mu.Lock()
		h.dropped = map[string]bool{}
		dropPlayers(v, h.dropped)
		h.gen, h.t, h.sources = v["gen"], v["t"], v["sources"]
		h.objs, h.order = map[string]obj{}, nil
		list, _ := v["objects"].([]any)
		for _, o := range list {
			m := o.(obj)
			id := idKey(m["i"])
			h.objs[id] = m
			h.order = append(h.order, id)
		}
		h.have = true
		b := h.snapshotBlock()
		h.mu.Unlock()
		h.broadcast(b)
	case "pos":
		h.mu.Lock()
		if !h.have {
			h.mu.Unlock()
			return
		}
		d, _ := v["d"].([]any)
		keptD := make([]any, 0, len(d))
		for _, e := range d {
			a, ok := e.([]any)
			if !ok || len(a) < 4 || h.dropped[idKey(a[0])] {
				continue
			}
			keptD = append(keptD, a)
			if o := h.objs[idKey(a[0])]; o != nil {
				o["x"], o["y"], o["z"] = a[1], a[2], a[3]
			}
		}
		r, _ := v["r"].([]any)
		keptR := make([]any, 0, len(r))
		for _, id := range r {
			k := idKey(id)
			if h.dropped[k] {
				delete(h.dropped, k)
				continue
			}
			delete(h.objs, k)
			keptR = append(keptR, id)
		}
		h.gen, h.t = v["gen"], v["t"]
		h.mu.Unlock()
		if len(keptD) > 0 || len(keptR) > 0 {
			h.broadcast(block("pos", obj{"gen": v["gen"], "t": v["t"], "d": keptD, "r": keptR}))
		}
	}
}

// serve writes the fan-out stream to one visitor until the link ends, the visitor leaves or the
// Console refuses. active reports whether the link is still valid.
func (h *hub) serve(w http.ResponseWriter, r *http.Request, active func() bool) {
	sub, ok := h.subscribe()
	if !ok {
		jsonError(w, http.StatusServiceUnavailable, "too many viewers")
		return
	}
	defer h.unsubscribe(sub)
	fl, _ := w.(http.Flusher)
	started := false
	start := func() {
		hd := w.Header()
		hd.Set("Content-Type", "text/event-stream")
		hd.Set("Cache-Control", "no-store")
		hd.Set("X-Accel-Buffering", "no")
		w.WriteHeader(http.StatusOK)
		started = true
	}
	wait := time.NewTimer(15 * time.Second)
	defer wait.Stop()
	check := time.NewTicker(5 * time.Second)
	defer check.Stop()
	ka := time.NewTicker(15 * time.Second)
	defer ka.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case code := <-sub.fail:
			if !started {
				jsonError(w, code, "realtime data unavailable")
			}
			return
		case b := <-sub.ch:
			if !started {
				start()
			}
			if _, err := w.Write(b); err != nil {
				return
			}
			if fl != nil {
				fl.Flush()
			}
		case <-wait.C:
			if !started {
				jsonError(w, http.StatusGatewayTimeout, "no realtime data yet")
				return
			}
		case <-check.C:
			if !active() {
				return
			}
		case <-ka.C:
			if started {
				if _, err := fmt.Fprint(w, ": ok\n\n"); err != nil {
					return
				}
				if fl != nil {
					fl.Flush()
				}
			}
		}
	}
}
