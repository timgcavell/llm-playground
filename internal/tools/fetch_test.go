package tools

import (
	"context"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

// The sandbox is the reason this tool is safe to expose at all, and it is the
// part the port could most easily have weakened: HTMLRewriter and Workers
// egress both went away, so the checks are all new code.
func TestPrivateHosts(t *testing.T) {
	blocked := []string{
		"localhost", "127.0.0.1", "0.0.0.0", "10.1.2.3", "172.16.0.1", "192.168.1.1",
		"169.254.169.254", // cloud metadata, and reachable from Cloud Run
		"100.64.0.1",      // carrier-grade NAT
		"[::1]", "[fe80::1]", "[fc00::1]",
		"foo.internal", "db.local", "thing.home.arpa",
	}
	for _, host := range blocked {
		if !isPrivateHost(host) {
			t.Errorf("isPrivateHost(%q) = false, want true", host)
		}
	}
	for _, host := range []string{"example.com", "8.8.8.8", "api.github.com", "[2606:4700::1]"} {
		if isPrivateHost(host) {
			t.Errorf("isPrivateHost(%q) = true, want false", host)
		}
	}
}

func TestCheckURL(t *testing.T) {
	cases := []struct {
		url     string
		refused bool
	}{
		{"https://example.com", false},
		{"http://example.com", false},
		{"file:///etc/passwd", true},
		{"ftp://example.com", true},
		{"http://169.254.169.254/latest/meta-data/", true},
		{"https://llm.timgcavell.com/api/chat", true}, // our own address
	}
	for _, testCase := range cases {
		parsed, err := url.Parse(testCase.url)
		if err != nil {
			t.Fatalf("parsing %q: %v", testCase.url, err)
		}
		refusal := checkURL(parsed, "llm.timgcavell.com")
		if (refusal != "") != testCase.refused {
			t.Errorf("checkURL(%q) = %q, refused=%v want %v",
				testCase.url, refusal, refusal != "", testCase.refused)
		}
	}
}

// htmlToText replaces HTMLRewriter. Same job, entirely different mechanism, so
// the behaviour worth pinning is that script and style contents stay out.
func TestHTMLToText(t *testing.T) {
	page := `<html><head><title>T</title><style>body{color:red}</style></head>
	<body><h1>Example Domain</h1><p>This domain is for use in examples.</p>
	<script>var secret = "should not appear";</script>
	<ul><li>one</li><li>two</li></ul></body></html>`

	text := htmlToText(strings.NewReader(page))

	for _, want := range []string{"Example Domain", "This domain is for use in examples.", "one", "two"} {
		if !strings.Contains(text, want) {
			t.Errorf("text is missing %q\ngot: %s", want, text)
		}
	}
	for _, unwanted := range []string{"should not appear", "color:red", "<h1>"} {
		if strings.Contains(text, unwanted) {
			t.Errorf("text should not contain %q\ngot: %s", unwanted, text)
		}
	}
}

// A credential must reach its own hosts and no others, and must not survive a
// redirect off them.
//
// These drive a stub transport rather than httptest, because httptest listens
// on loopback and fetch_url refuses private addresses — correctly. Testing
// through a RoundTripper keeps the guard intact and still exercises the header
// logic against public-looking hostnames.
type stubTransport struct {
	seen      []*http.Request
	responses map[string]*http.Response
}

func (t *stubTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	t.seen = append(t.seen, req)
	if response, ok := t.responses[req.URL.Host]; ok {
		return response, nil
	}
	return jsonResponse(http.StatusOK, `{"ok":true}`), nil
}

func jsonResponse(status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       io.NopCloser(strings.NewReader(body)),
	}
}

func redirectResponse(to string) *http.Response {
	return &http.Response{
		StatusCode: http.StatusFound,
		Header:     http.Header{"Location": []string{to}},
		Body:       io.NopCloser(strings.NewReader("")),
	}
}

func credentialEnv(transport *stubTransport, hosts ...string) *Env {
	return &Env{
		HTTP: &http.Client{Transport: transport},
		Credentials: []Credential{{
			Label:   "Test",
			Hosts:   hosts,
			Headers: map[string]string{"Authorization": "Bearer SECRET"},
		}},
	}
}

func TestFetchCredentialScoping(t *testing.T) {
	transport := &stubTransport{}
	env := credentialEnv(transport, "api.example.test")

	result := fetchURL(context.Background(), map[string]any{"url": "https://api.example.test/v1"}, env)
	if !result.OK {
		t.Fatalf("fetch failed: %s", result.Content)
	}
	if got := transport.seen[0].Header.Get("Authorization"); got != "Bearer SECRET" {
		t.Fatalf("credential not sent to its own host: %q", got)
	}
	if !strings.Contains(result.Content, "Authenticated: Test") {
		t.Error("an authenticated fetch should say so in the transcript")
	}

	transport.seen = nil
	result = fetchURL(context.Background(), map[string]any{"url": "https://other.example.test/"}, env)
	if !result.OK {
		t.Fatalf("fetch failed: %s", result.Content)
	}
	if got := transport.seen[0].Header.Get("Authorization"); got != "" {
		t.Fatalf("credential leaked to an unrelated host: %q", got)
	}
	if strings.Contains(result.Content, "Authenticated") {
		t.Error("an unauthenticated fetch should not claim otherwise")
	}
}

func TestFetchDropsCredentialAcrossRedirect(t *testing.T) {
	transport := &stubTransport{responses: map[string]*http.Response{
		"api.example.test": redirectResponse("https://collector.example.test/steal"),
	}}
	env := credentialEnv(transport, "api.example.test")

	result := fetchURL(context.Background(), map[string]any{"url": "https://api.example.test/leak"}, env)
	if !result.OK {
		t.Fatalf("fetch failed: %s", result.Content)
	}
	if len(transport.seen) != 2 {
		t.Fatalf("expected two hops, saw %d", len(transport.seen))
	}
	if got := transport.seen[0].Header.Get("Authorization"); got != "Bearer SECRET" {
		t.Errorf("first hop should carry the credential, got %q", got)
	}
	if got := transport.seen[1].Header.Get("Authorization"); got != "" {
		t.Errorf("credential leaked across a cross-host redirect: %q", got)
	}
}

// A redirect into private space must be caught mid-chain, not just at the
// first hop.
func TestFetchRefusesRedirectIntoPrivateSpace(t *testing.T) {
	transport := &stubTransport{responses: map[string]*http.Response{
		"public.example.test": redirectResponse("http://169.254.169.254/latest/meta-data/"),
	}}
	env := &Env{HTTP: &http.Client{Transport: transport}}

	result := fetchURL(context.Background(), map[string]any{"url": "https://public.example.test/hop"}, env)
	if result.OK {
		t.Fatal("a redirect to the metadata address should be refused")
	}
	if !strings.Contains(result.Content, "Refused") {
		t.Errorf("unexpected refusal text: %s", result.Content)
	}
}
