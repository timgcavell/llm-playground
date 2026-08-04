package providers

import (
	"bytes"
	"encoding/json"
	"net/http"
)

type OpenAI struct{}

func (*OpenAI) Name() string   { return "openai" }
func (*OpenAI) Label() string  { return "OpenAI" }
func (*OpenAI) KeyEnv() string { return "OPENAI_API_KEY" }

func (*OpenAI) Models() []Model {
	return []Model{
		{ID: "gpt-4.1", Label: "GPT-4.1", Temperature: true, Thinking: false},
		{ID: "gpt-4.1-mini", Label: "GPT-4.1 mini", Temperature: true, Thinking: false},
		{ID: "gpt-4o", Label: "GPT-4o", Temperature: true, Thinking: false},
		// Reasoning models reject temperature and keep their reasoning private.
		{ID: "o3", Label: "o3", Temperature: false, Thinking: false},
		{ID: "o4-mini", Label: "o4-mini", Temperature: false, Thinking: false},
	}
}

func (*OpenAI) Build(req Request) (*http.Request, error) {
	messages := make([]any, 0, len(req.Messages)+len(req.Extra)+1)
	if req.System != "" {
		messages = append(messages, map[string]any{"role": "system", "content": req.System})
	}
	for _, message := range req.Messages {
		messages = append(messages, map[string]any{"role": message.Role, "content": message.Content})
	}
	messages = append(messages, req.Extra...)

	body := map[string]any{
		"model":                 req.Model,
		"stream":                true,
		"stream_options":        map[string]any{"include_usage": true},
		"max_completion_tokens": req.MaxTokens,
		"messages":              messages,
	}
	if req.Caps.Temperature && req.Temperature != nil {
		body["temperature"] = *req.Temperature
	}
	if len(req.Tools) > 0 {
		tools := make([]any, len(req.Tools))
		for i, tool := range req.Tools {
			tools[i] = map[string]any{
				"type": "function",
				"function": map[string]any{
					"name":        tool.Name,
					"description": tool.Description,
					"parameters":  tool.Schema,
				},
			}
		}
		body["tools"] = tools
	}

	encoded, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	httpReq, err := http.NewRequest(http.MethodPost,
		"https://api.openai.com/v1/chat/completions", bytes.NewReader(encoded))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Authorization", "Bearer "+req.APIKey)
	httpReq.Header.Set("content-type", "application/json")
	return httpReq, nil
}

func (*OpenAI) NewDecoder() Decoder { return &openaiDecoder{} }

type openaiCall struct {
	ID   string
	Name string
	Args string
}

// openaiDecoder reassembles tool calls that arrive as sparse deltas: the id
// and name land once, then the arguments accumulate as a JSON string, split at
// arbitrary points.
type openaiDecoder struct {
	text  string
	calls []openaiCall
}

func (d *openaiDecoder) ensure(index int) {
	for len(d.calls) <= index {
		d.calls = append(d.calls, openaiCall{})
	}
}

func (d *openaiDecoder) Decode(payload []byte) ([]Event, error) {
	// The stream ends with a sentinel that is not JSON.
	if string(bytes.TrimSpace(payload)) == "[DONE]" {
		return nil, nil
	}

	var chunk struct {
		Choices []struct {
			Delta struct {
				Content   string `json:"content"`
				ToolCalls []struct {
					Index    int    `json:"index"`
					ID       string `json:"id"`
					Function struct {
						Name      string `json:"name"`
						Arguments string `json:"arguments"`
					} `json:"function"`
				} `json:"tool_calls"`
			} `json:"delta"`
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
		Usage *struct {
			PromptTokens     int `json:"prompt_tokens"`
			CompletionTokens int `json:"completion_tokens"`
		} `json:"usage"`
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
	var finishReason string
	if len(chunk.Choices) > 0 {
		choice := chunk.Choices[0]
		finishReason = choice.FinishReason

		if choice.Delta.Content != "" {
			d.text += choice.Delta.Content
			events = append(events, TextEvent(choice.Delta.Content))
		}
		for _, delta := range choice.Delta.ToolCalls {
			d.ensure(delta.Index)
			slot := &d.calls[delta.Index]
			if delta.ID != "" {
				slot.ID = delta.ID
			}
			slot.Name += delta.Function.Name
			slot.Args += delta.Function.Arguments
		}
		if finishReason == "tool_calls" {
			for _, call := range d.calls {
				input := map[string]any{}
				if call.Args != "" {
					_ = json.Unmarshal([]byte(call.Args), &input)
				}
				events = append(events, Event{
					Type:  "tool_call",
					ID:    call.ID,
					Name:  call.Name,
					Input: input,
				})
			}
		}
	}

	if finishReason != "" || chunk.Usage != nil {
		usage := Usage{}
		if chunk.Usage != nil {
			usage = Usage{Input: chunk.Usage.PromptTokens, Output: chunk.Usage.CompletionTokens}
		}
		events = append(events, Event{Type: "meta", StopReason: finishReason, Usage: &usage})
	}
	return events, nil
}

func (d *openaiDecoder) AssistantTurn() []any {
	if d.text == "" && len(d.calls) == 0 {
		return nil
	}
	message := map[string]any{"role": "assistant"}
	// A turn that only called tools has no content; the field must still be
	// present and null rather than omitted.
	if d.text != "" {
		message["content"] = d.text
	} else {
		message["content"] = nil
	}
	if len(d.calls) > 0 {
		calls := make([]any, len(d.calls))
		for i, call := range d.calls {
			args := call.Args
			if args == "" {
				args = "{}"
			}
			calls[i] = map[string]any{
				"id":       call.ID,
				"type":     "function",
				"function": map[string]any{"name": call.Name, "arguments": args},
			}
		}
		message["tool_calls"] = calls
	}
	return []any{message}
}

func (d *openaiDecoder) ResultTurn(results []ToolResult) []any {
	// One message per result here, unlike the other two vendors.
	turns := make([]any, len(results))
	for i, result := range results {
		turns[i] = map[string]any{
			"role":         "tool",
			"tool_call_id": result.ID,
			"content":      result.Content,
		}
	}
	return turns
}
