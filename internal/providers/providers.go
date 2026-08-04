// Package providers adapts each vendor's chat API to one interface.
//
// The Worker version kept per-response parser state in a mutable object passed
// back into every call. Go has a better shape for that: a Provider is
// stateless and hands out a Decoder per response, so the state has an obvious
// owner and lifetime, and two concurrent conversations cannot share it.
package providers

import (
	"fmt"
	"net/http"
	"sort"
)

// Event is the normalized shape everything above this package sees. The JSON
// tags matter: these go to the browser unchanged, and the front end already
// speaks this vocabulary.
type Event struct {
	Type string `json:"type"`

	Text    string         `json:"text,omitempty"`
	ID      string         `json:"id,omitempty"`
	Name    string         `json:"name,omitempty"`
	Input   map[string]any `json:"input,omitempty"`
	Summary string         `json:"summary,omitempty"`
	OK      *bool          `json:"ok,omitempty"`
	Content string         `json:"content,omitempty"`

	StopReason string `json:"stopReason,omitempty"`
	Usage      *Usage `json:"usage,omitempty"`
	Round      *int   `json:"round,omitempty"`
	Message    string `json:"message,omitempty"`
}

type Usage struct {
	Input  int `json:"input"`
	Output int `json:"output"`
}

// Event constructors, so the string literals live in one place.
func TextEvent(text string) Event     { return Event{Type: "text", Text: text} }
func ThinkingEvent(text string) Event { return Event{Type: "thinking", Text: text} }
func ErrorEvent(format string, args ...any) Event {
	return Event{Type: "error", Message: fmt.Sprintf(format, args...)}
}

type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// ToolSpec is a tool as the model should see it: vendor-neutral JSON Schema
// that each adapter translates into its own dialect.
type ToolSpec struct {
	Name        string
	Description string
	Schema      map[string]any
}

// ToolResult is what a tool produced, on the way back to the model.
type ToolResult struct {
	ID      string
	Name    string
	OK      bool
	Content string
}

// Caps records where vendors disagree about fundamentals.
type Caps struct {
	// Temperature is false where the API rejects sampling parameters outright
	// rather than ignoring them.
	Temperature bool
	// Thinking is true where the model streams reasoning we can surface.
	Thinking bool
}

type Model struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Temperature bool   `json:"temperature"`
	Thinking    bool   `json:"thinking"`
}

// Request is one upstream call.
type Request struct {
	APIKey      string
	Model       string
	Caps        Caps
	System      string
	Messages    []Message
	Temperature *float64
	MaxTokens   int
	Tools       []ToolSpec
	// Extra holds native turns accumulated by the tool loop — assistant turns
	// carrying tool calls, and the results answering them. They are vendor
	// shaped by definition, so they stay opaque above this package.
	Extra []any
}

// Decoder turns one response's SSE payloads into events, and can rebuild the
// turn it just read in the vendor's own shape.
//
// The rebuild is the awkward part of tool calling: the assistant turn holding
// a tool call has to go back verbatim, and reasoning blocks carry signatures
// the vendor validates. So decoders accumulate the native content as it
// streams rather than reconstructing it afterwards.
type Decoder interface {
	Decode(payload []byte) ([]Event, error)
	AssistantTurn() []any
	ResultTurn(results []ToolResult) []any
}

type Provider interface {
	Name() string
	Label() string
	KeyEnv() string
	Models() []Model
	Build(req Request) (*http.Request, error)
	NewDecoder() Decoder
}

// Registry holds the providers that have an API key configured.
type Registry struct {
	byName map[string]Provider
}

func NewRegistry(lookupEnv func(string) string) *Registry {
	registry := &Registry{byName: map[string]Provider{}}
	for _, provider := range []Provider{&Anthropic{}, &Google{}, &OpenAI{}} {
		if lookupEnv(provider.KeyEnv()) != "" {
			registry.byName[provider.Name()] = provider
		}
	}
	return registry
}

func (r *Registry) Get(name string) (Provider, bool) {
	provider, ok := r.byName[name]
	return provider, ok
}

func (r *Registry) Names() []string {
	names := make([]string, 0, len(r.byName))
	for name := range r.byName {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// CapsFor tolerates a model typed by hand: an unlisted id still works, it just
// inherits the provider's defaults.
func CapsFor(provider Provider, modelID string) Caps {
	for _, model := range provider.Models() {
		if model.ID == modelID {
			return Caps{Temperature: model.Temperature, Thinking: model.Thinking}
		}
	}
	return defaultCaps(provider)
}

func defaultCaps(provider Provider) Caps {
	switch provider.(type) {
	case *Anthropic:
		// Current Anthropic models reject temperature with a 400, so an
		// unrecognized one is assumed to behave the same way.
		return Caps{Temperature: false, Thinking: true}
	default:
		return Caps{Temperature: true, Thinking: false}
	}
}
