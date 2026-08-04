package agent

import (
	"context"
	"io"
	"strings"
	"testing"
)

// consumeSSE is where a provider's bytes become payloads, so it has to survive
// the ways real streams arrive: CRLF line endings, multi-line data fields,
// comments, and a payload larger than bufio's default buffer.
func TestConsumeSSE(t *testing.T) {
	stream := strings.Join([]string{
		": a comment",
		"event: message_start",
		`data: {"one":1}`,
		"",
		"data: line one",
		"data: line two",
		"",
		"data: {\"crlf\":true}\r",
		"",
	}, "\n")

	var payloads []string
	err := consumeSSE(context.Background(), strings.NewReader(stream), func(p []byte) bool {
		payloads = append(payloads, string(p))
		return true
	})
	if err != nil {
		t.Fatalf("consumeSSE: %v", err)
	}

	want := []string{`{"one":1}`, "line one\nline two", `{"crlf":true}`}
	if len(payloads) != len(want) {
		t.Fatalf("got %d payloads (%q), want %d", len(payloads), payloads, len(want))
	}
	for i := range want {
		if payloads[i] != want[i] {
			t.Errorf("payload %d = %q, want %q", i, payloads[i], want[i])
		}
	}
}

func TestConsumeSSELargePayload(t *testing.T) {
	// Well past bufio.Scanner's 64KB default, which a long tool argument hits.
	big := strings.Repeat("x", 300_000)
	var got string
	err := consumeSSE(context.Background(), strings.NewReader("data: "+big+"\n\n"),
		func(p []byte) bool { got = string(p); return true })
	if err != nil {
		t.Fatalf("consumeSSE: %v", err)
	}
	if len(got) != len(big) {
		t.Fatalf("payload truncated: got %d bytes, want %d", len(got), len(big))
	}
}

// A consumer that stops reading must not drain the rest of the stream.
func TestConsumeSSEStops(t *testing.T) {
	count := 0
	err := consumeSSE(context.Background(),
		strings.NewReader("data: one\n\ndata: two\n\ndata: three\n\n"),
		func([]byte) bool { count++; return false })
	if err != nil {
		t.Fatalf("consumeSSE: %v", err)
	}
	if count != 1 {
		t.Fatalf("kept reading after the consumer stopped: %d payloads", count)
	}
}

var _ io.Reader = strings.NewReader("")
