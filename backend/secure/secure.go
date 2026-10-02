// Package secure speichert die Zugangsdaten (Server-Adresse, API-Token) doppelt
// verschlüsselt, gehasht und an Rechner und Benutzer gebunden.
//
// Aufbau:
//
//   - Hauptschlüssel: 32 Zufallsbytes in <UserConfigDir>/MapViewer3D/master.key
//     (Rechte 0600), getrennt von den verschlüsselten Daten.
//   - Schlüsselableitung: HKDF-SHA512 aus Hauptschlüssel, Zufallssalz und einer
//     Rechnerbindung (Hostname, Benutzer-ID); je Schicht ein eigener Schlüssel.
//   - Schicht 1 (innen): AES-256-GCM.
//   - Schicht 2 (außen): XChaCha20-Poly1305.
//   - Integrität: HMAC-SHA512 über den gesamten Umschlag (encrypt-then-MAC).
//   - Fingerabdruck: gesalzener SHA-512-Hash (PBKDF2, 210 000 Runden) des Tokens,
//     zur Anzeige und zum Vergleich, ohne den Token preiszugeben.
//
// Wer Benutzerkonto und Hauptschlüssel des Rechners besitzt, kann die Daten
// entschlüsseln; ohne den Schlüssel (z. B. bei kopierten Projektdateien) nicht.
package secure

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha512"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/user"
	"path/filepath"

	"golang.org/x/crypto/chacha20poly1305"
)

// Credentials sind die geheimen Zugangsdaten.
type Credentials struct {
	APIBase string `json:"apiBase"` // z. B. http://host:8088
	Token   string `json:"token"`
	// Pin: Fingerabdruck (sha256/…) eines selbst signierten oder internen
	// Zertifikats der Console; leer = Zertifikatsstellen des Systems.
	Pin string `json:"pin,omitempty"`
}

type envelope struct {
	Version     int    `json:"v"`
	Salt        string `json:"salt"`
	InnerNonce  string `json:"n1"`
	OuterNonce  string `json:"n2"`
	Ciphertext  string `json:"ct"`
	Fingerprint string `json:"fp"`  // gesalzener Hash des Tokens
	FPSalt      string `json:"fps"` // Salz des Fingerabdrucks
	MAC         string `json:"mac"`
}

// Store verwaltet die verschlüsselte Datei file und den Schlüssel in keyDir.
type Store struct {
	file   string
	keyDir string
}

// Open legt die Verzeichnisse an; keyDir leer = Benutzer-Konfigordner.
func Open(file, keyDir string) (*Store, error) {
	if keyDir == "" {
		base, err := os.UserConfigDir()
		if err != nil {
			return nil, err
		}
		keyDir = filepath.Join(base, "MapViewer3D")
	}
	if err := os.MkdirAll(keyDir, 0o700); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		return nil, err
	}
	return &Store{file: file, keyDir: keyDir}, nil
}

func (s *Store) keyFile() string { return filepath.Join(s.keyDir, "master.key") }

// Sibling öffnet eine weitere verschlüsselte Datei mit demselben Hauptschlüssel
// (gespeicherte Server der Serverliste).
func (s *Store) Sibling(file string) (*Store, error) { return Open(file, s.keyDir) }

// master liest oder erzeugt den Hauptschlüssel.
func (s *Store) master(create bool) ([]byte, error) {
	b, err := os.ReadFile(s.keyFile())
	if err == nil && len(b) == 32 {
		return b, nil
	}
	if !create {
		return nil, errors.New("Hauptschlüssel fehlt")
	}
	k := make([]byte, 32)
	if _, err := rand.Read(k); err != nil {
		return nil, err
	}
	if err := os.WriteFile(s.keyFile(), k, 0o600); err != nil {
		return nil, err
	}
	return k, nil
}

// binding koppelt die Schlüssel an Rechner und Benutzerkonto.
func binding() []byte {
	host, _ := os.Hostname()
	uid := ""
	if u, err := user.Current(); err == nil {
		uid = u.Uid + "/" + u.Username
	}
	return []byte("MapViewer3D|" + host + "|" + uid)
}

func derive(master, salt []byte, purpose string, n int) ([]byte, error) {
	info := append([]byte("mv3d/"+purpose+"|"), binding()...)
	return hkdf.Key(sha512.New, master, salt, string(info), n)
}

// Fingerprint ist ein gesalzener, langsamer Hash des Tokens (Hex, gekürzt).
func Fingerprint(token string, salt []byte) (string, error) {
	h, err := pbkdf2.Key(sha512.New, token, salt, 210000, 32)
	if err != nil {
		return "", err
	}
	return hex.EncodeToString(h), nil
}

// Save verschlüsselt und speichert die Zugangsdaten. Nichts davon steht im
// Klartext in der Datei, auch nicht die Server-Adresse.
func (s *Store) Save(c Credentials) error {
	master, err := s.master(true)
	if err != nil {
		return err
	}
	rnd := func(n int) []byte {
		b := make([]byte, n)
		rand.Read(b)
		return b
	}
	salt, fpSalt := rnd(32), rnd(16)
	k1, err := derive(master, salt, "aes-gcm", 32)
	if err != nil {
		return err
	}
	k2, err := derive(master, salt, "xchacha20", 32)
	if err != nil {
		return err
	}
	kMac, err := derive(master, salt, "hmac", 64)
	if err != nil {
		return err
	}
	plain, _ := json.Marshal(c)

	block, _ := aes.NewCipher(k1)
	gcm, _ := cipher.NewGCM(block)
	n1 := rnd(gcm.NonceSize())
	inner := gcm.Seal(nil, n1, plain, []byte("mv3d-inner"))

	xc, err := chacha20poly1305.NewX(k2)
	if err != nil {
		return err
	}
	n2 := rnd(xc.NonceSize())
	outer := xc.Seal(nil, n2, inner, []byte("mv3d-outer"))

	fp, err := Fingerprint(c.Token, fpSalt)
	if err != nil {
		return err
	}
	b64 := base64.StdEncoding.EncodeToString
	env := envelope{Version: 1, Salt: b64(salt), InnerNonce: b64(n1), OuterNonce: b64(n2),
		Ciphertext: b64(outer), Fingerprint: fp, FPSalt: b64(fpSalt)}
	env.MAC = b64(mac(kMac, env))
	data, _ := json.MarshalIndent(env, "", "  ")
	tmp := s.file + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.file)
}

func mac(key []byte, e envelope) []byte {
	m := hmac.New(sha512.New, key)
	for _, part := range []string{fmt.Sprint(e.Version), e.Salt, e.InnerNonce, e.OuterNonce, e.Ciphertext, e.Fingerprint, e.FPSalt} {
		m.Write([]byte(part))
		m.Write([]byte{0})
	}
	return m.Sum(nil)
}

// ErrNotConfigured: noch keine Zugangsdaten gespeichert.
var ErrNotConfigured = errors.New("keine Zugangsdaten gespeichert")

// Load entschlüsselt die Zugangsdaten und prüft Integrität und Fingerabdruck.
func (s *Store) Load() (*Credentials, error) {
	data, err := os.ReadFile(s.file)
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNotConfigured
	}
	if err != nil {
		return nil, err
	}
	var env envelope
	if err := json.Unmarshal(data, &env); err != nil || env.Version != 1 {
		return nil, errors.New("Zugangsdaten beschädigt")
	}
	master, err := s.master(false)
	if err != nil {
		return nil, fmt.Errorf("Zugangsdaten nicht lesbar: %w", err)
	}
	d := base64.StdEncoding.DecodeString
	salt, err1 := d(env.Salt)
	n1, err2 := d(env.InnerNonce)
	n2, err3 := d(env.OuterNonce)
	ct, err4 := d(env.Ciphertext)
	tag, err5 := d(env.MAC)
	fpSalt, err6 := d(env.FPSalt)
	if err := errors.Join(err1, err2, err3, err4, err5, err6); err != nil {
		return nil, errors.New("Zugangsdaten beschädigt")
	}
	k1, _ := derive(master, salt, "aes-gcm", 32)
	k2, _ := derive(master, salt, "xchacha20", 32)
	kMac, _ := derive(master, salt, "hmac", 64)
	if !hmac.Equal(tag, mac(kMac, env)) {
		return nil, errors.New("Zugangsdaten verändert oder von einem anderen Rechner")
	}
	xc, err := chacha20poly1305.NewX(k2)
	if err != nil {
		return nil, err
	}
	inner, err := xc.Open(nil, n2, ct, []byte("mv3d-outer"))
	if err != nil {
		return nil, errors.New("äußere Verschlüsselung ungültig")
	}
	block, _ := aes.NewCipher(k1)
	gcm, _ := cipher.NewGCM(block)
	plain, err := gcm.Open(nil, n1, inner, []byte("mv3d-inner"))
	if err != nil {
		return nil, errors.New("innere Verschlüsselung ungültig")
	}
	var c Credentials
	if err := json.Unmarshal(plain, &c); err != nil {
		return nil, errors.New("Zugangsdaten beschädigt")
	}
	if fp, err := Fingerprint(c.Token, fpSalt); err != nil || !hmac.Equal([]byte(fp), []byte(env.Fingerprint)) {
		return nil, errors.New("Fingerabdruck stimmt nicht")
	}
	return &c, nil
}

// Info liefert Angaben zur Anzeige: Server (entschlüsselt, ohne Token) und den
// gekürzten Fingerabdruck des Tokens.
func (s *Store) Info() (host, fingerprint string, ok bool) {
	data, err := os.ReadFile(s.file)
	if err != nil {
		return "", "", false
	}
	var env envelope
	if json.Unmarshal(data, &env) != nil {
		return "", "", false
	}
	c, err := s.Load()
	if err != nil {
		return "", "", false
	}
	fp := env.Fingerprint
	if len(fp) > 16 {
		fp = fp[:16]
	}
	host = c.APIBase
	if u, err := url.Parse(c.APIBase); err == nil {
		host = u.Host
	}
	return host, fp, true
}

// Delete entfernt die gespeicherten Zugangsdaten (der Hauptschlüssel bleibt).
func (s *Store) Delete() error {
	err := os.Remove(s.file)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}
