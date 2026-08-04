// Package kv talks to Cloudflare Workers KV over its REST API.
//
// On Workers, KV arrived as a binding: a method call on an object the runtime
// handed you, costing well under a millisecond. Off Workers there is no
// binding, so every read and write is an HTTPS round trip to Cloudflare —
// tens of milliseconds, and able to fail. That difference is the reason this
// package exists rather than a thin wrapper: callers need a context they can
// cancel, errors they can inspect, and a client that keeps connections warm.
package kv

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const apiBase = "https://api.cloudflare.com/client/v4"

// ErrNotFound is returned by Get for a key that is absent or expired.
// Callers distinguish "no value" from "lookup failed" with errors.Is: on
// Workers a missing key was a null return, but here a failed request must not
// be mistaken for an empty store — that would read as "this grant was
// revoked" and quietly deny a valid token.
var ErrNotFound = errors.New("kv: key not found")

// Store is one Cloudflare KV namespace.
type Store struct {
	client      *http.Client
	accountID   string
	namespaceID string
	token       string
}

// Config carries the credentials for a namespace.
type Config struct {
	AccountID   string
	NamespaceID string
	APIToken    string
}

func New(cfg Config) (*Store, error) {
	if cfg.AccountID == "" || cfg.NamespaceID == "" || cfg.APIToken == "" {
		return nil, errors.New("kv: account id, namespace id and api token are all required")
	}
	return &Store{
		// The default client has no timeout at all, which turns one slow
		// Cloudflare response into a request of ours that never returns.
		client: &http.Client{
			Timeout: 10 * time.Second,
			Transport: &http.Transport{
				MaxIdleConnsPerHost: 32,
				IdleConnTimeout:     90 * time.Second,
			},
		},
		accountID:   cfg.AccountID,
		namespaceID: cfg.NamespaceID,
		token:       cfg.APIToken,
	}, nil
}

func (s *Store) urlFor(suffix string) string {
	return fmt.Sprintf("%s/accounts/%s/storage/kv/namespaces/%s%s",
		apiBase, s.accountID, s.namespaceID, suffix)
}

func (s *Store) do(req *http.Request) (*http.Response, error) {
	req.Header.Set("Authorization", "Bearer "+s.token)
	return s.client.Do(req)
}

// apiResult is Cloudflare's envelope. A 200 with success:false is a failure,
// so the status code alone is not enough to go on.
type apiResult struct {
	Success bool `json:"success"`
	Errors  []struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"errors"`
	Result     json.RawMessage `json:"result"`
	ResultInfo struct {
		Cursor string `json:"cursor"`
	} `json:"result_info"`
}

func (r apiResult) err() error {
	if r.Success {
		return nil
	}
	if len(r.Errors) > 0 {
		return fmt.Errorf("kv: cloudflare error %d: %s", r.Errors[0].Code, r.Errors[0].Message)
	}
	return errors.New("kv: request unsuccessful")
}

func decodeEnvelope(resp *http.Response) (apiResult, error) {
	defer resp.Body.Close()
	var result apiResult
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return result, fmt.Errorf("kv: decoding response: %w", err)
	}
	return result, result.err()
}

// Get returns the raw value, or ErrNotFound. Reads bypass the envelope: the
// value endpoint returns the stored bytes directly.
func (s *Store) Get(ctx context.Context, key string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		s.urlFor("/values/"+url.PathEscape(key)), nil)
	if err != nil {
		return nil, err
	}
	resp, err := s.do(req)
	if err != nil {
		return nil, fmt.Errorf("kv: get %q: %w", key, err)
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusOK:
		return io.ReadAll(resp.Body)
	case http.StatusNotFound:
		return nil, ErrNotFound
	default:
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, fmt.Errorf("kv: get %q: status %d: %s", key, resp.StatusCode, body)
	}
}

// GetJSON unmarshals into v. Reports false, nil when the key is absent, so
// callers can branch on presence without an errors.Is at every site.
func (s *Store) GetJSON(ctx context.Context, key string, v any) (bool, error) {
	raw, err := s.Get(ctx, key)
	if errors.Is(err, ErrNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if err := json.Unmarshal(raw, v); err != nil {
		return false, fmt.Errorf("kv: decoding %q: %w", key, err)
	}
	return true, nil
}

// PutOption configures a write.
type PutOption func(*url.Values)

// WithTTL expires the key after d. Cloudflare's minimum is 60 seconds;
// anything shorter is raised to it rather than rejected, since a value that
// silently never expires is the worse failure.
func WithTTL(d time.Duration) PutOption {
	return func(q *url.Values) {
		seconds := int64(d.Seconds())
		if seconds < 60 {
			seconds = 60
		}
		q.Set("expiration_ttl", strconv.FormatInt(seconds, 10))
	}
}

// Put stores a value. The REST API takes multipart form data here, unlike the
// binding's plain value argument.
func (s *Store) Put(ctx context.Context, key string, value []byte, opts ...PutOption) error {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if err := writer.WriteField("value", string(value)); err != nil {
		return err
	}
	if err := writer.WriteField("metadata", "{}"); err != nil {
		return err
	}
	if err := writer.Close(); err != nil {
		return err
	}

	query := url.Values{}
	for _, opt := range opts {
		opt(&query)
	}
	endpoint := s.urlFor("/values/" + url.PathEscape(key))
	if len(query) > 0 {
		endpoint += "?" + query.Encode()
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPut, endpoint, &body)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", writer.FormDataContentType())

	resp, err := s.do(req)
	if err != nil {
		return fmt.Errorf("kv: put %q: %w", key, err)
	}
	if _, err := decodeEnvelope(resp); err != nil {
		return fmt.Errorf("kv: put %q: %w", key, err)
	}
	return nil
}

// PutJSON marshals v and stores it.
func (s *Store) PutJSON(ctx context.Context, key string, v any, opts ...PutOption) error {
	encoded, err := json.Marshal(v)
	if err != nil {
		return fmt.Errorf("kv: encoding %q: %w", key, err)
	}
	return s.Put(ctx, key, encoded, opts...)
}

// Delete removes a key. Deleting an absent key is not an error, matching the
// binding and letting callers delete without checking first.
func (s *Store) Delete(ctx context.Context, key string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete,
		s.urlFor("/values/"+url.PathEscape(key)), nil)
	if err != nil {
		return err
	}
	resp, err := s.do(req)
	if err != nil {
		return fmt.Errorf("kv: delete %q: %w", key, err)
	}
	if resp.StatusCode == http.StatusNotFound {
		resp.Body.Close()
		return nil
	}
	if _, err := decodeEnvelope(resp); err != nil {
		return fmt.Errorf("kv: delete %q: %w", key, err)
	}
	return nil
}

// List returns the keys under prefix, following pagination cursors so callers
// get the whole set rather than the first page.
func (s *Store) List(ctx context.Context, prefix string, limit int) ([]string, error) {
	var keys []string
	cursor := ""

	for {
		query := url.Values{}
		if prefix != "" {
			query.Set("prefix", prefix)
		}
		if cursor != "" {
			query.Set("cursor", cursor)
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet,
			s.urlFor("/keys?"+query.Encode()), nil)
		if err != nil {
			return nil, err
		}
		resp, err := s.do(req)
		if err != nil {
			return nil, fmt.Errorf("kv: list %q: %w", prefix, err)
		}
		result, err := decodeEnvelope(resp)
		if err != nil {
			return nil, fmt.Errorf("kv: list %q: %w", prefix, err)
		}

		var page []struct {
			Name string `json:"name"`
		}
		if err := json.Unmarshal(result.Result, &page); err != nil {
			return nil, fmt.Errorf("kv: decoding key list: %w", err)
		}
		for _, entry := range page {
			keys = append(keys, entry.Name)
			if limit > 0 && len(keys) >= limit {
				return keys, nil
			}
		}

		cursor = result.ResultInfo.Cursor
		if cursor == "" {
			return keys, nil
		}
	}
}

// Namespaced returns a Store whose keys are all prefixed. Used to keep the
// OAuth keyspace and the memory keyspace apart when they share a namespace.
func (s *Store) Namespaced(prefix string) *Prefixed {
	return &Prefixed{store: s, prefix: prefix}
}

// Prefixed is a Store viewed through a key prefix.
type Prefixed struct {
	store  *Store
	prefix string
}

func (p *Prefixed) Get(ctx context.Context, key string) ([]byte, error) {
	return p.store.Get(ctx, p.prefix+key)
}

func (p *Prefixed) GetJSON(ctx context.Context, key string, v any) (bool, error) {
	return p.store.GetJSON(ctx, p.prefix+key, v)
}

func (p *Prefixed) Put(ctx context.Context, key string, value []byte, opts ...PutOption) error {
	return p.store.Put(ctx, p.prefix+key, value, opts...)
}

func (p *Prefixed) PutJSON(ctx context.Context, key string, v any, opts ...PutOption) error {
	return p.store.PutJSON(ctx, p.prefix+key, v, opts...)
}

func (p *Prefixed) Delete(ctx context.Context, key string) error {
	return p.store.Delete(ctx, p.prefix+key)
}

func (p *Prefixed) List(ctx context.Context, prefix string, limit int) ([]string, error) {
	keys, err := p.store.List(ctx, p.prefix+prefix, limit)
	if err != nil {
		return nil, err
	}
	trimmed := make([]string, len(keys))
	for i, key := range keys {
		trimmed[i] = strings.TrimPrefix(key, p.prefix)
	}
	return trimmed, nil
}
