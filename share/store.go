package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"sync"
	"time"
)

// A share link is a random 256-bit token. Only the SHA-256 of the token is stored, so a copy of the
// state file cannot be turned into working links, and a token cannot be guessed or forged: there is no
// structure to forge, a token either is one of the random values this process issued or it is not.
const (
	tokenPrefix = "mvs_"
	maxLinks    = 200
	minTTL      = time.Minute
	maxTTL      = 5 * 365 * 24 * time.Hour
)

var tokenPattern = regexp.MustCompile(`^mvs_[A-Za-z0-9_-]{43}$`)

type link struct {
	ID       string `json:"id"`
	Hash     string `json:"hash"`
	Label    string `json:"label"`
	Created  int64  `json:"created"`
	Expires  int64  `json:"expires"` // unix seconds, 0 = never
	Players  bool   `json:"players"`
	Bases    bool   `json:"bases"`
	Realtime bool   `json:"realtime"`
	Revoked  bool   `json:"revoked,omitempty"`
}

// linkView is what the admin API shows: never the hash, never the token.
type linkView struct {
	ID       string `json:"id"`
	Label    string `json:"label"`
	Created  int64  `json:"created"`
	Expires  int64  `json:"expires"`
	Players  bool   `json:"players"`
	Bases    bool   `json:"bases"`
	Realtime bool   `json:"realtime"`
	Active   bool   `json:"active"`
	LastUsed int64  `json:"lastUsed"`
}

type linkOptions struct {
	Label    string
	TTL      time.Duration // 0 = never expires
	Players  bool
	Bases    bool
	Realtime bool
}

type store struct {
	mu       sync.Mutex
	path     string
	now      func() time.Time
	links    []link
	byHash   map[string]int
	lastUsed map[string]int64 // id -> unix seconds, memory only
}

func newStore(dir string) (*store, error) {
	s := &store{path: filepath.Join(dir, "links.json"), now: time.Now, byHash: map[string]int{}, lastUsed: map[string]int64{}}
	b, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(b, &s.links); err != nil {
		return nil, errors.New("links.json is not valid: " + err.Error())
	}
	kept := s.links[:0]
	for _, l := range s.links { // links revoked by older versions are removed now
		if !l.Revoked {
			kept = append(kept, l)
		}
	}
	s.links = kept
	s.reindex()
	return s, nil
}

func (s *store) reindex() {
	s.byHash = make(map[string]int, len(s.links))
	for i, l := range s.links {
		s.byHash[l.Hash] = i
	}
}

func hashToken(token string) string {
	h := sha256.Sum256([]byte(token))
	return hex.EncodeToString(h[:])
}

func (s *store) active(l link) bool {
	return !l.Revoked && (l.Expires == 0 || s.now().Unix() < l.Expires)
}

func (s *store) save() error {
	b, err := json.MarshalIndent(s.links, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(b); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// prune drops links that ended more than 30 days ago.
func (s *store) prune() {
	cut := s.now().Add(-30 * 24 * time.Hour).Unix()
	kept := s.links[:0]
	for _, l := range s.links {
		if (l.Expires != 0 && l.Expires < cut) || (l.Revoked && l.Created < cut) {
			continue
		}
		kept = append(kept, l)
	}
	s.links = kept
	s.reindex()
}

var errTooMany = errors.New("too many active links; revoke some first")

// create issues a new link and returns its token. The token is returned exactly once.
func (s *store) create(o linkOptions) (string, linkView, error) {
	if o.TTL != 0 && (o.TTL < minTTL || o.TTL > maxTTL) {
		return "", linkView{}, errors.New("duration out of range")
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", linkView{}, err
	}
	token := tokenPrefix + base64.RawURLEncoding.EncodeToString(raw)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.prune()
	n := 0
	for _, l := range s.links {
		if s.active(l) {
			n++
		}
	}
	if n >= maxLinks {
		return "", linkView{}, errTooMany
	}
	h := hashToken(token)
	l := link{ID: h[:10], Hash: h, Label: o.Label, Created: s.now().Unix(), Players: o.Players, Bases: o.Bases, Realtime: o.Realtime}
	if o.TTL != 0 {
		l.Expires = s.now().Add(o.TTL).Unix()
	}
	s.links = append(s.links, l)
	s.reindex()
	if err := s.save(); err != nil {
		s.links = s.links[:len(s.links)-1]
		s.reindex()
		return "", linkView{}, err
	}
	return token, s.view(l), nil
}

func (s *store) view(l link) linkView {
	return linkView{ID: l.ID, Label: l.Label, Created: l.Created, Expires: l.Expires, Players: l.Players, Bases: l.Bases,
		Realtime: l.Realtime, Active: s.active(l), LastUsed: s.lastUsed[l.ID]}
}

func (s *store) list() []linkView {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]linkView, 0, len(s.links))
	for _, l := range s.links {
		out = append(out, s.view(l))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Created > out[j].Created })
	return out
}

func (s *store) revoke(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	// A revoked link is deleted outright: it vanishes from the list and its token never works again.
	for i := range s.links {
		if s.links[i].ID == id {
			removed := s.links[i]
			s.links = append(s.links[:i:i], s.links[i+1:]...)
			s.reindex()
			if err := s.save(); err != nil {
				s.links = append(s.links[:i:i], append([]link{removed}, s.links[i:]...)...)
				s.reindex()
				return false
			}
			return true
		}
	}
	return false
}

// lookup finds the active link for a token. The format is checked first, then the hash of the token
// is looked up, so nothing about a stored value depends on attacker-controlled input.
func (s *store) lookup(token string) (link, bool) {
	if !tokenPattern.MatchString(token) {
		return link{}, false
	}
	h := hashToken(token)
	s.mu.Lock()
	defer s.mu.Unlock()
	i, ok := s.byHash[h]
	if !ok || !s.active(s.links[i]) {
		return link{}, false
	}
	l := s.links[i]
	s.lastUsed[l.ID] = s.now().Unix()
	return l, true
}

// stillActive is the cheap re-check of an open stream.
func (s *store) stillActive(hash string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	i, ok := s.byHash[hash]
	return ok && s.active(s.links[i])
}
