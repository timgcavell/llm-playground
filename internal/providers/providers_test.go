package providers

import (
	"encoding/json"
	"testing"
)

// decode feeds payloads through a decoder the way the agent does: one shared
// decoder for the whole response.
func decode(t *testing.T, decoder Decoder, payloads ...string) []Event {
	t.Helper()
	var events []Event
	for _, payload := range payloads {
		batch, err := decoder.Decode([]byte(payload))
		if err != nil {
			t.Fatalf("decoding %s: %v", payload, err)
		}
		events = append(events, batch...)
	}
	return events
}

func textOf(events []Event) string {
	var text string
	for _, event := range events {
		if event.Type == "text" {
			text += event.Text
		}
	}
	return text
}

func callsOf(events []Event) []Event {
	var calls []Event
	for _, event := range events {
		if event.Type == "tool_call" {
			calls = append(calls, event)
		}
	}
	return calls
}

// The Anthropic round trip is the strictest: a thinking block goes back with
// its signature, and a tool call's arguments arrive split across deltas.
func TestAnthropicDecoder(t *testing.T) {
	decoder := (&Anthropic{}).NewDecoder()
	events := decode(t, decoder,
		`{"type":"message_start","message":{"usage":{"input_tokens":12}}}`,
		`{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}`,
		`{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"weighing it"}}`,
		`{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"SIGabc"}}`,
		`{"type":"content_block_stop","index":0}`,
		`{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}`,
		`{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hello"}}`,
		`{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":" there"}}`,
		`{"type":"content_block_stop","index":1}`,
		`{"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_1","name":"fetch_url","input":{}}}`,
		`{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"url\":\"https://ex"}}`,
		`{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"ample.com\"}"}}`,
		`{"type":"content_block_stop","index":2}`,
		`{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":34}}`,
	)

	if got := textOf(events); got != "Hello there" {
		t.Errorf("text = %q, want %q", got, "Hello there")
	}

	calls := callsOf(events)
	if len(calls) != 1 {
		t.Fatalf("got %d tool calls, want 1", len(calls))
	}
	if calls[0].ID != "toolu_1" || calls[0].Input["url"] != "https://example.com" {
		t.Errorf("tool call did not reassemble: %+v", calls[0])
	}

	var meta *Event
	for i := range events {
		if events[i].Type == "meta" {
			meta = &events[i]
		}
	}
	if meta == nil || meta.Usage.Input != 12 || meta.Usage.Output != 34 {
		t.Errorf("usage not correlated across frames: %+v", meta)
	}

	// The assistant turn has to go back verbatim, signature included, or the
	// next request is rejected.
	turn := decoder.AssistantTurn()
	if len(turn) != 1 {
		t.Fatalf("expected one assistant turn, got %d", len(turn))
	}
	content := turn[0].(map[string]any)["content"].([]any)
	thinking := content[0].(map[string]any)
	if thinking["thinking"] != "weighing it" || thinking["signature"] != "SIGabc" {
		t.Errorf("thinking block lost its content or signature: %+v", thinking)
	}

	results := decoder.ResultTurn([]ToolResult{{ID: "toolu_1", Name: "fetch_url", OK: false, Content: "Refused"}})
	block := results[0].(map[string]any)["content"].([]any)[0].(map[string]any)
	if block["tool_use_id"] != "toolu_1" || block["is_error"] != true {
		t.Errorf("tool result block is wrong: %+v", block)
	}
}

// OpenAI splits both the name and the arguments across deltas, and ends with a
// sentinel that is not JSON.
func TestOpenAIDecoder(t *testing.T) {
	decoder := (&OpenAI{}).NewDecoder()
	events := decode(t, decoder,
		`{"choices":[{"delta":{"content":"One sec."}}]}`,
		`{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"fetch_","arguments":""}}]}}]}`,
		`{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"url","arguments":"{\"url\":"}}]}}]}`,
		`{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"https://example.com\"}"}}]}}]}`,
		`{"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":40,"completion_tokens":12}}`,
		`[DONE]`,
	)

	calls := callsOf(events)
	if len(calls) != 1 {
		t.Fatalf("got %d tool calls, want 1", len(calls))
	}
	if calls[0].Name != "fetch_url" {
		t.Errorf("name did not reassemble across deltas: %q", calls[0].Name)
	}
	if calls[0].Input["url"] != "https://example.com" {
		t.Errorf("arguments did not reassemble: %+v", calls[0].Input)
	}

	turn := decoder.AssistantTurn()[0].(map[string]any)
	if turn["content"] != "One sec." {
		t.Errorf("assistant text lost: %+v", turn["content"])
	}
	toolCalls := turn["tool_calls"].([]any)
	function := toolCalls[0].(map[string]any)["function"].(map[string]any)
	if function["arguments"] != `{"url":"https://example.com"}` {
		t.Errorf("arguments not replayed verbatim: %v", function["arguments"])
	}

	// One message per result here, unlike the other two vendors.
	results := decoder.ResultTurn([]ToolResult{{ID: "call_1", Name: "fetch_url", OK: true, Content: "page"}})
	if len(results) != 1 {
		t.Fatalf("expected one message per result, got %d", len(results))
	}
	if results[0].(map[string]any)["role"] != "tool" {
		t.Errorf("wrong role: %+v", results[0])
	}
}

// Gemini marks reasoning on the part and attaches thought signatures that have
// to survive the round trip.
func TestGoogleDecoder(t *testing.T) {
	decoder := (&Google{}).NewDecoder()
	events := decode(t, decoder,
		`{"candidates":[{"content":{"parts":[{"text":"planning","thought":true,"thoughtSignature":"SIGxyz"}]}}]}`,
		`{"candidates":[{"content":{"parts":[{"functionCall":{"name":"fetch_url","args":{"url":"https://example.com"}}}]}}]}`,
		`{"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":30,"candidatesTokenCount":9}}`,
	)

	var thinking string
	for _, event := range events {
		if event.Type == "thinking" {
			thinking += event.Text
		}
	}
	if thinking != "planning" {
		t.Errorf("thinking = %q, want %q", thinking, "planning")
	}

	calls := callsOf(events)
	if len(calls) != 1 || calls[0].Name != "fetch_url" {
		t.Fatalf("tool call not decoded: %+v", calls)
	}

	turn := decoder.AssistantTurn()[0].(map[string]any)
	parts := turn["parts"].([]any)
	first := parts[0].(map[string]any)
	if first["thoughtSignature"] != "SIGxyz" {
		t.Errorf("thought signature must round-trip: %+v", first)
	}

	results := decoder.ResultTurn([]ToolResult{{Name: "fetch_url", OK: true, Content: "page"}})
	response := results[0].(map[string]any)["parts"].([]any)[0].(map[string]any)
	functionResponse := response["functionResponse"].(map[string]any)
	if functionResponse["name"] != "fetch_url" {
		t.Errorf("function response is wrong: %+v", functionResponse)
	}
}

// Tool declarations must reach each vendor in its own dialect, and must be
// absent entirely when there are none.
func TestToolDeclarations(t *testing.T) {
	tools := []ToolSpec{{
		Name:        "fetch_url",
		Description: "d",
		Schema:      map[string]any{"type": "object"},
	}}
	base := Request{APIKey: "k", Model: "m", MaxTokens: 100,
		Messages: []Message{{Role: "user", Content: "hi"}}}

	bodyOf := func(t *testing.T, provider Provider, req Request) map[string]any {
		t.Helper()
		httpReq, err := provider.Build(req)
		if err != nil {
			t.Fatalf("build: %v", err)
		}
		var body map[string]any
		if err := json.NewDecoder(httpReq.Body).Decode(&body); err != nil {
			t.Fatalf("decoding body: %v", err)
		}
		return body
	}

	withTools := base
	withTools.Tools = tools

	anthropic := bodyOf(t, &Anthropic{}, withTools)
	if _, ok := anthropic["tools"].([]any)[0].(map[string]any)["input_schema"]; !ok {
		t.Error("Anthropic wants input_schema")
	}

	google := bodyOf(t, &Google{}, withTools)
	declarations := google["tools"].([]any)[0].(map[string]any)["functionDeclarations"]
	if declarations == nil {
		t.Error("Google wants functionDeclarations")
	}

	openai := bodyOf(t, &OpenAI{}, withTools)
	if openai["tools"].([]any)[0].(map[string]any)["type"] != "function" {
		t.Error(`OpenAI wants type: "function"`)
	}

	if body := bodyOf(t, &Anthropic{}, base); body["tools"] != nil {
		t.Error("omitting tools must not leave a stray key")
	}
}

// Temperature is where the vendors disagree hardest: current Anthropic models
// reject it outright rather than ignoring it.
func TestTemperatureGating(t *testing.T) {
	temperature := 0.7
	req := Request{APIKey: "k", Model: "claude-opus-5", MaxTokens: 100,
		Temperature: &temperature,
		Messages:    []Message{{Role: "user", Content: "hi"}},
		Caps:        CapsFor(&Anthropic{}, "claude-opus-5")}

	httpReq, err := (&Anthropic{}).Build(req)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	var body map[string]any
	_ = json.NewDecoder(httpReq.Body).Decode(&body)
	if _, present := body["temperature"]; present {
		t.Error("claude-opus-5 must not receive a temperature")
	}
	if body["thinking"] == nil {
		t.Error("thinking should stay on for a model that supports it")
	}

	// An unlisted model inherits the provider's defaults rather than failing.
	if caps := CapsFor(&Anthropic{}, "claude-something-new"); caps.Temperature {
		t.Error("an unknown Anthropic model should default to refusing temperature")
	}
	if caps := CapsFor(&OpenAI{}, "gpt-next"); !caps.Temperature {
		t.Error("an unknown OpenAI model should default to accepting temperature")
	}
}
