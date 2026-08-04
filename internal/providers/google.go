package providers

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
)

type Google struct{}

func (*Google) Name() string   { return "google" }
func (*Google) Label() string  { return "Google Gemini" }
func (*Google) KeyEnv() string { return "GEMINI_API_KEY" }

func (*Google) Models() []Model {
	return []Model{
		{ID: "gemini-flash-latest", Label: "Gemini Flash Latest", Temperature: true, Thinking: true},
		{ID: "gemini-3.6-flash", Label: "Gemini 3.6 Flash", Temperature: true, Thinking: true},
		{ID: "gemini-3.5-flash-lite", Label: "Gemini 3.5 Flash Lite", Temperature: true, Thinking: false},
	}
}

func (*Google) Build(req Request) (*http.Request, error) {
	contents := make([]any, 0, len(req.Messages)+len(req.Extra))
	for _, message := range req.Messages {
		role := "user"
		if message.Role == "assistant" {
			role = "model"
		}
		contents = append(contents, map[string]any{
			"role":  role,
			"parts": []any{map[string]any{"text": message.Content}},
		})
	}
	contents = append(contents, req.Extra...)

	generation := map[string]any{"maxOutputTokens": req.MaxTokens}
	if req.Caps.Temperature && req.Temperature != nil {
		generation["temperature"] = *req.Temperature
	}

	body := map[string]any{"contents": contents, "generationConfig": generation}
	if req.System != "" {
		body["systemInstruction"] = map[string]any{
			"parts": []any{map[string]any{"text": req.System}},
		}
	}
	if len(req.Tools) > 0 {
		declarations := make([]any, len(req.Tools))
		for i, tool := range req.Tools {
			declarations[i] = map[string]any{
				"name":        tool.Name,
				"description": tool.Description,
				"parameters":  tool.Schema,
			}
		}
		body["tools"] = []any{map[string]any{"functionDeclarations": declarations}}
	}

	encoded, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	endpoint := fmt.Sprintf(
		"https://generativelanguage.googleapis.com/v1beta/models/%s:streamGenerateContent?alt=sse",
		url.PathEscape(req.Model))
	httpReq, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(encoded))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("x-goog-api-key", req.APIKey)
	httpReq.Header.Set("content-type", "application/json")
	return httpReq, nil
}

func (*Google) NewDecoder() Decoder { return &googleDecoder{} }

// googleDecoder keeps parts exactly as sent. Gemini attaches thought
// signatures to parts, and they have to survive the round trip through a tool
// call or the next request is rejected.
type googleDecoder struct {
	parts     []any
	callCount int
}

func (d *googleDecoder) Decode(payload []byte) ([]Event, error) {
	var chunk struct {
		Candidates []struct {
			Content struct {
				Parts []map[string]any `json:"parts"`
			} `json:"content"`
			FinishReason string `json:"finishReason"`
		} `json:"candidates"`
		UsageMetadata struct {
			PromptTokenCount     int `json:"promptTokenCount"`
			CandidatesTokenCount int `json:"candidatesTokenCount"`
		} `json:"usageMetadata"`
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(payload, &chunk); err != nil {
		return nil, err
	}
	if chunk.Error.Message != "" {
		return []Event{ErrorEvent("%s", chunk.Error.Message)}, nil
	}

	var events []Event
	var candidate = struct {
		Parts        []map[string]any
		FinishReason string
	}{}
	if len(chunk.Candidates) > 0 {
		candidate.Parts = chunk.Candidates[0].Content.Parts
		candidate.FinishReason = chunk.Candidates[0].FinishReason
	}

	for _, part := range candidate.Parts {
		d.parts = append(d.parts, part)

		if call, ok := part["functionCall"].(map[string]any); ok {
			// Gemini function calls carry no id of their own; results are
			// matched by name, so a local id is only needed to pair call with
			// result in the transcript.
			name := str(call["name"])
			args, _ := call["args"].(map[string]any)
			if args == nil {
				args = map[string]any{}
			}
			events = append(events, Event{
				Type:  "tool_call",
				ID:    fmt.Sprintf("%s-%d", name, d.callCount),
				Name:  name,
				Input: args,
			})
			d.callCount++
			continue
		}
		if text, ok := part["text"].(string); ok {
			// Reasoning is marked with `thought` on the part rather than
			// having its own event type.
			if thought, _ := part["thought"].(bool); thought {
				events = append(events, ThinkingEvent(text))
			} else {
				events = append(events, TextEvent(text))
			}
		}
	}

	if candidate.FinishReason != "" || chunk.UsageMetadata.PromptTokenCount > 0 {
		events = append(events, Event{
			Type:       "meta",
			StopReason: candidate.FinishReason,
			Usage: &Usage{
				Input:  chunk.UsageMetadata.PromptTokenCount,
				Output: chunk.UsageMetadata.CandidatesTokenCount,
			},
		})
	}
	return events, nil
}

func (d *googleDecoder) AssistantTurn() []any {
	if len(d.parts) == 0 {
		return nil
	}
	return []any{map[string]any{"role": "model", "parts": d.parts}}
}

func (d *googleDecoder) ResultTurn(results []ToolResult) []any {
	parts := make([]any, len(results))
	for i, result := range results {
		response := map[string]any{"result": result.Content}
		if !result.OK {
			response = map[string]any{"error": result.Content}
		}
		parts[i] = map[string]any{
			"functionResponse": map[string]any{"name": result.Name, "response": response},
		}
	}
	return []any{map[string]any{"role": "user", "parts": parts}}
}
