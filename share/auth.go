package main

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// The administrator manages links with the Console API key they already use in the addon: the
// gateway checks that key against the Console itself (nothing is typed twice, there is no second
// password to set up). The admin secret (mva_…) stays as an alternative for scripts.
//
// A key can only authorise what it can do itself: a link may offer players, bases or Realtime Data only
// if the key that creates it can read them (and the gateway's own key can serve them).
//
// The gateway's own read-only key (the "service key") is taken over from the first valid admin key
// when none is stored, or when the stored one is rejected (rotated or revoked). A working service
// key is never replaced by a presented one.

type caps struct {
	Console  bool   // the Console answered
	KeyOK    bool   // the key was accepted
	Maps     bool   // maps: Read
	Bases    bool   // bases: Read
	Players  bool   // players visible through maps
	Realtime bool   // Realtime Data: Read and the agent runs
	Admin    bool   // addons: Read - the proof of an administrator (see authenticate)
	Why      string // why Realtime Data is not available
}

func and(a, b caps) caps {
	return caps{Console: a.Console && b.Console, KeyOK: a.KeyOK && b.KeyOK, Maps: a.Maps && b.Maps, Bases: a.Bases && b.Bases,
		Players: a.Players && b.Players, Realtime: a.Realtime && b.Realtime, Admin: a.Admin, Why: firstNonEmpty(a.Why, b.Why)}
}

func firstNonEmpty(s ...string) string {
	for _, v := range s {
		if v != "" {
			return v
		}
	}
	return ""
}

// probeCaps asks the Console what a key can read.
func (g *gateway) probeCaps(ctx context.Context, key string) caps {
	probe := func(p, q string) int {
		req, err := g.upstreamRequestKey(ctx, key, p, q)
		if err != nil {
			return 0
		}
		resp, err := g.client.Do(req)
		if err != nil {
			return -1
		}
		io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
		resp.Body.Close()
		return resp.StatusCode
	}
	var c caps
	maps := probe("/api/map/partitions", "")
	c.Console = maps > 0
	c.KeyOK = maps != 401 && maps > 0
	c.Maps = maps == 200
	if !c.Maps {
		return c
	}
	c.Admin = probe("/api/addons/installed", "") == 200
	c.Bases = probe("/api/bases/0/export", "") != 403
	c.Players = probe("/api/map/players", "map=Survival_1") == 200
	switch rt := probe("/api/realtime/healthz", ""); rt {
	case 200:
		c.Realtime = true
	case 403:
		c.Why = "key lacks the Realtime Data scope"
	case 404:
		c.Why = "console has no Realtime Data"
	case 503:
		c.Why = "position agent not running"
	default:
		c.Why = "unavailable"
	}
	return c
}

type capEntry struct {
	at time.Time
	c  caps
}

type authState struct {
	mu    sync.Mutex
	keys  map[string]capEntry // sha256(key) -> caps, 30 s
	svc   capEntry
	adopt sync.Mutex
}

const capsTTL = 30 * time.Second

type principal struct {
	key    string // empty for the admin secret
	caps   caps
	secret bool
}

// authError is why a caller was refused. Needs names the scope an otherwise valid key lacks.
type authError struct {
	Status int
	Msg    string
	Needs  string
}

var (
	errNoCredential = &authError{Status: http.StatusUnauthorized, Msg: "an API key or the admin secret is required"}
	errNoConsole    = &authError{Status: http.StatusServiceUnavailable, Msg: "console unreachable"}
	errNoMaps       = &authError{Status: http.StatusForbidden, Msg: "the key needs maps: Read", Needs: "maps:read"}
	errNotAdmin     = &authError{Status: http.StatusForbidden, Msg: "managing share links needs an administrator's key: grant it Addons: Read (Settings, API Keys)", Needs: "addons:read"}
)

// authenticate identifies the caller of the admin API.
//
// An API key is accepted only if the Console accepts it AND it holds the scope Addons: Read. That scope
// is what separates the administrator from the many other keys a server has (bots, monitoring: those
// carry maps: Read at most): without it any such key could publish links, delete everybody's links or
// take over the gateway's own key. The admin secret (mva_, for scripts) is the other way in.
func (g *gateway) authenticate(ctx context.Context, r *http.Request) (p principal, fail *authError) {
	a := r.Header.Get("Authorization")
	if len(a) < 8 || !strings.EqualFold(a[:7], "bearer ") {
		return p, errNoCredential
	}
	cred := strings.TrimSpace(a[7:])
	switch {
	case strings.HasPrefix(cred, adminPrefix):
		d := sha256.Sum256([]byte(cred))
		if subtle.ConstantTimeCompare(d[:], g.adminDigest[:]) == 1 {
			return principal{secret: true}, nil
		}
		return p, errNoCredential
	case keyPattern.MatchString(cred):
		d := sha256.Sum256([]byte(cred))
		id := hex.EncodeToString(d[:])
		g.auth.mu.Lock()
		e, ok := g.auth.keys[id]
		g.auth.mu.Unlock()
		if !ok || time.Since(e.at) > capsTTL {
			e = capEntry{at: time.Now(), c: g.probeCaps(ctx, cred)}
			if e.c.KeyOK && e.c.Maps {
				g.auth.mu.Lock()
				if len(g.auth.keys) > 256 {
					g.auth.keys = map[string]capEntry{}
				}
				g.auth.keys[id] = e
				g.auth.mu.Unlock()
			}
		}
		switch {
		case !e.c.Console:
			return p, errNoConsole
		case !e.c.KeyOK:
			return p, errNoCredential
		case !e.c.Maps:
			return p, errNoMaps
		case !e.c.Admin:
			return p, errNotAdmin
		}
		return principal{key: cred, caps: e.c}, nil
	}
	return p, errNoCredential
}

// serviceCaps is what the gateway's own key can serve (cached).
func (g *gateway) serviceCaps(ctx context.Context) caps {
	key := g.serviceKey()
	if key == "" {
		return caps{}
	}
	g.auth.mu.Lock()
	e := g.auth.svc
	g.auth.mu.Unlock()
	if time.Since(e.at) < 15*time.Second && e.at != (time.Time{}) {
		return e.c
	}
	c := g.probeCaps(ctx, key)
	g.auth.mu.Lock()
	g.auth.svc = capEntry{at: time.Now(), c: c}
	g.auth.mu.Unlock()
	return c
}

// maybeAdopt makes the presented admin key the gateway's service key when there is none or the
// stored one is rejected by the Console. It reports whether it did.
func (g *gateway) maybeAdopt(ctx context.Context, key string) bool {
	g.auth.adopt.Lock()
	defer g.auth.adopt.Unlock()
	cur := g.serviceKey()
	if cur == key {
		return false
	}
	if cur != "" && g.serviceCaps(ctx).KeyOK { // cached: this runs on every admin call
		// (a working service key is never replaced by a presented one)
		return false
	}
	tmp := g.cfg.KeyFile + ".tmp"
	if err := os.MkdirAll(filepath.Dir(g.cfg.KeyFile), 0o700); err != nil {
		return false
	}
	if err := os.WriteFile(tmp, []byte(key+"\n"), 0o600); err != nil {
		return false
	}
	if err := os.Rename(tmp, g.cfg.KeyFile); err != nil {
		return false
	}
	g.keyMu.Lock()
	g.keyVal, g.keyStamp = key, time.Now()
	g.keyMu.Unlock()
	g.auth.mu.Lock()
	g.auth.svc = capEntry{}
	g.auth.mu.Unlock()
	g.cacheMu.Lock()
	g.cache = map[string]*centry{}
	g.cacheMu.Unlock()
	log.Printf("mvshare: the administrator's API key is now the gateway's read-only key")
	return true
}

// effective is what a link made by this caller can offer.
func (g *gateway) effective(ctx context.Context, p principal) caps {
	svc := g.serviceCaps(ctx)
	if p.secret {
		return svc
	}
	return and(p.caps, svc)
}

func (g *gateway) statusDoc(ctx context.Context, p principal, adopted bool) []byte {
	c := g.effective(ctx, p)
	st := obj{"version": version, "keyConfigured": g.serviceKey() != "", "keyAccepted": g.serviceCaps(ctx).KeyOK, "adopted": adopted,
		"console": c.Console, "maps": c.Maps, "bases": c.Bases, "players": c.Players, "realtime": c.Realtime, "realtimeReason": c.Why}
	return mustJSON(st)
}
