// Package access verifies Cloudflare Access identity tokens.
//
// This is the one piece that ports almost unchanged, because it never depended
// on the Workers runtime — it verifies a JWT against the team's public keys.
// What does change is why it matters. On Workers, Cloudflare sat in front of
// the code and nothing arrived unfiltered. Cloud Run is reachable at its own
// URL whether or not a request came through Cloudflare, so this verification
// is no longer a second opinion: it is the only thing standing between a
// gated route and the open internet.
package access

import (
	"context"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"
)

var (
	ErrNoToken  = errors.New("access: no identity token presented")
	ErrRejected = errors.New("access: identity token rejected")
)

// Identity is who Cloudflare says is calling. A browser login carries an
// email; a service token carries a common name instead. Either is something
// state can be keyed on, so callers get one field rather than two.
type Identity struct {
	Subject string
	Email   string
}

// Verifier checks tokens for one Access application.
type Verifier struct {
	teamDomain string
	audience   string
	client     *http.Client

	mu        sync.RWMutex
	keys      map[string]*rsa.PublicKey
	fetchedAt time.Time
}

func NewVerifier(teamDomain, audience string) *Verifier {
	return &Verifier{
		teamDomain: teamDomain,
		audience:   audience,
		client:     &http.Client{Timeout: 5 * time.Second},
		keys:       map[string]*rsa.PublicKey{},
	}
}

// Configured reports whether an audience was supplied. With none there is no
// way to verify anything, and the caller must decide what that means — in
// production, refusing.
func (v *Verifier) Configured() bool { return v.audience != "" }

type jwks struct {
	Keys []struct {
		Kid string `json:"kid"`
		N   string `json:"n"`
		E   string `json:"e"`
	} `json:"keys"`
}

// refreshKeys fetches the team's signing keys. Cached, because this runs on
// every gated request and the keys rotate on the order of weeks.
func (v *Verifier) refreshKeys(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		fmt.Sprintf("https://%s/cdn-cgi/access/certs", v.teamDomain), nil)
	if err != nil {
		return err
	}
	resp, err := v.client.Do(req)
	if err != nil {
		return fmt.Errorf("access: fetching signing keys: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("access: fetching signing keys: status %d", resp.StatusCode)
	}

	var parsed jwks
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return fmt.Errorf("access: decoding signing keys: %w", err)
	}

	keys := make(map[string]*rsa.PublicKey, len(parsed.Keys))
	for _, key := range parsed.Keys {
		modulus, err := base64.RawURLEncoding.DecodeString(key.N)
		if err != nil {
			continue
		}
		exponent, err := base64.RawURLEncoding.DecodeString(key.E)
		if err != nil {
			continue
		}
		// The exponent is big-endian and usually three bytes; pad it into a
		// uint32 rather than assuming a length.
		padded := make([]byte, 4)
		copy(padded[4-len(exponent):], exponent)
		keys[key.Kid] = &rsa.PublicKey{
			N: new(big.Int).SetBytes(modulus),
			E: int(binary.BigEndian.Uint32(padded)),
		}
	}

	v.mu.Lock()
	v.keys = keys
	v.fetchedAt = time.Now()
	v.mu.Unlock()
	return nil
}

func (v *Verifier) keyFor(ctx context.Context, kid string) (*rsa.PublicKey, error) {
	v.mu.RLock()
	key, ok := v.keys[kid]
	age := time.Since(v.fetchedAt)
	v.mu.RUnlock()
	if ok {
		return key, nil
	}
	// An unknown kid means either rotation or a forgery. Refetch once, but not
	// on every miss, or an invalid token becomes a way to make us hammer
	// Cloudflare.
	if age < time.Minute {
		return nil, ErrRejected
	}
	if err := v.refreshKeys(ctx); err != nil {
		return nil, err
	}
	v.mu.RLock()
	defer v.mu.RUnlock()
	if key, ok := v.keys[kid]; ok {
		return key, nil
	}
	return nil, ErrRejected
}

type claims struct {
	Email      string `json:"email"`
	CommonName string `json:"common_name"`
	Subject    string `json:"sub"`
	Expiry     int64  `json:"exp"`
	Audience   any    `json:"aud"`
}

// audienceMatches handles aud being either a string or an array — the JWT spec
// allows both, and Access uses the array form.
func (c claims) audienceMatches(want string) bool {
	switch value := c.Audience.(type) {
	case string:
		return value == want
	case []any:
		for _, entry := range value {
			if text, ok := entry.(string); ok && text == want {
				return true
			}
		}
	}
	return false
}

// Verify checks the token on the request and returns who it belongs to.
func (v *Verifier) Verify(ctx context.Context, r *http.Request) (Identity, error) {
	token := r.Header.Get("Cf-Access-Jwt-Assertion")
	if token == "" {
		if cookie, err := r.Cookie("CF_Authorization"); err == nil {
			token = cookie.Value
		}
	}
	if token == "" {
		return Identity{}, ErrNoToken
	}

	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return Identity{}, ErrRejected
	}

	var header struct {
		Kid string `json:"kid"`
		Alg string `json:"alg"`
	}
	headerJSON, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || json.Unmarshal(headerJSON, &header) != nil {
		return Identity{}, ErrRejected
	}
	// Pin the algorithm. Accepting whatever the token names is how "alg: none"
	// and RS256-verified-as-HMAC forgeries get in.
	if header.Alg != "RS256" {
		return Identity{}, ErrRejected
	}

	key, err := v.keyFor(ctx, header.Kid)
	if err != nil {
		return Identity{}, err
	}

	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return Identity{}, ErrRejected
	}
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if err := rsa.VerifyPKCS1v15(key, crypto.SHA256, digest[:], signature); err != nil {
		return Identity{}, ErrRejected
	}

	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return Identity{}, ErrRejected
	}
	var parsed claims
	if err := json.Unmarshal(payload, &parsed); err != nil {
		return Identity{}, ErrRejected
	}

	if parsed.Expiry > 0 && time.Now().After(time.Unix(parsed.Expiry, 0)) {
		return Identity{}, ErrRejected
	}
	if !parsed.audienceMatches(v.audience) {
		return Identity{}, ErrRejected
	}

	subject := parsed.Email
	if subject == "" {
		subject = parsed.CommonName
	}
	if subject == "" {
		return Identity{}, ErrRejected
	}
	return Identity{Subject: subject, Email: parsed.Email}, nil
}
