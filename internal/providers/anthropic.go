package providers

import (
	"bytes"
	"encoding/json"
	"net/http"
)

const anthropicVersion = "2023-06-01"

type Anthropic struct{}

func (*Anthropic) Name() string   { return "anthropic" }
func (*Anthropic) Label() string  { return "Anthropic" }
func (*Anthropic) KeyEnv() string { return "ANTHROPIC_API_KEY" }

func (*Anthropic) Models() []Model {
	return []Model{
		{ID: "claude-opus-5", Label: "Claude Opus 5", Temperature: false, Thinking: true},
		{ID: "claude-sonnet-5", Label: "Claude Sonnet 5", Temperature: false, Thinking: true},
		{ID: "claude-haiku-4-5", Label: "Claude Haiku 4.5", Temperature: true, Thinking: false},
	}
}

func (*Anthropic) Build(req Request) (*http.Request, error) {
	messages := make([]any, 0, len(req.Messages)+len(req.Extra))
	for _, message := range req.Messages {
		messages = append(messages, map[string]any{"role": message.Role, "content": message.Content})
	}
	messages = append(messages, req.Extra...)

	body := map[string]any{
		"model":      req.Model,
		"max_tokens": req.MaxTokens,
		"stream":     true,
		"messages":   messages,
	}
	if req.System != "" {
		body["system"] = req.System
	}
	// Adaptive thinking stays on during tool use: with it disabled these
	// models sometimes describe a call in prose instead of emitting a real
	// tool_use block, which fails silently.
	if req.Caps.Thinking {
		body["thinking"] = map[string]any{"type": "adaptive", "display": "summarized"}
	}
	if req.Caps.Temperature && req.Temperature != nil {
		body["temperature"] = *req.Temperature
	}
	if len(req.Tools) > 0 {
		tools := make([]any, len(req.Tools))
		for i, tool := range req.Tools {
			tools[i] = map[string]any{
				"name":         tool.Name,
				"description":  tool.Description,
				"input_schema": tool.Schema,
			}
		}
		body["tools"] = tools
	}

	encoded, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	httpReq, err := http.NewRequest(http.MethodPost, "https://api.anthropic.com/v1/messages", bytes.NewReader(encoded))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("x-api-key", req.APIKey)
	httpReq.Header.Set("anthropic-version", anthropicVersion)
	httpReq.Header.Set("content-type", "application/json")
	return httpReq, nil
}

func (*Anthropic) NewDecoder() Decoder { return &anthropicDecoder{} }

// anthropicDecoder accumulates the content blocks exactly as they arrive.
// Keeping them verbatim is what lets a thinking block go back with its
// signature intact; a reconstruction would be rejected.
type anthropicDecoder struct {
	blocks      []map[string]any
	partialJSON map[int]string
	inputTokens int
}

func (d *anthropicDecoder) ensure(index int) {
	for len(d.blocks) <= index {
		d.blocks = append(d.blocks, nil)
	}
}

func (d *anthropicDecoder) Decode(payload []byte) ([]Event, error) {
	var chunk struct {
		Type  string `json:"type"`
		Index int    `json:"index"`

		Message struct {
			Usage struct {
				InputTokens int `json:"input_tokens"`
			} `json:"usage"`
		} `json:"message"`

		ContentBlock map[string]any `json:"content_block"`

		Delta struct {
			Type        string `json:"type"`
			Text        string `json:"text"`
			Thinking    string `json:"thinking"`
			Signature   string `json:"signature"`
			PartialJSON string `json:"partial_json"`
			StopReason  string `json:"stop_reason"`
		} `json:"delta"`

		Usage struct {
			OutputTokens int `json:"output_tokens"`
		} `json:"usage"`

		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(payload, &chunk); err != nil {
		return nil, err
	}

	switch chunk.Type {
	case "message_start":
		d.inputTokens = chunk.Message.Usage.InputTokens
		return nil, nil

	case "content_block_start":
		d.ensure(chunk.Index)
		block := map[string]any{}
		for key, value := range chunk.ContentBlock {
			block[key] = value
		}
		d.blocks[chunk.Index] = block
		if block["type"] == "tool_use" {
			if d.partialJSON == nil {
				d.partialJSON = map[int]string{}
			}
			d.partialJSON[chunk.Index] = ""
		}
		return nil, nil

	case "content_block_delta":
		d.ensure(chunk.Index)
		block := d.blocks[chunk.Index]
		switch chunk.Delta.Type {
		case "text_delta":
			if block != nil {
				block["text"] = str(block["text"]) + chunk.Delta.Text
			}
			return []Event{TextEvent(chunk.Delta.Text)}, nil
		case "thinking_delta":
			if block != nil {
				block["thinking"] = str(block["thinking"]) + chunk.Delta.Thinking
			}
			return []Event{ThinkingEvent(chunk.Delta.Thinking)}, nil
		case "signature_delta":
			// No visible content, but the block is rejected on the way back
			// without it.
			if block != nil {
				block["signature"] = str(block["signature"]) + chunk.Delta.Signature
			}
			return nil, nil
		case "input_json_delta":
			d.partialJSON[chunk.Index] += chunk.Delta.PartialJSON
			return nil, nil
		}
		return nil, nil

	case "content_block_stop":
		d.ensure(chunk.Index)
		block := d.blocks[chunk.Index]
		if block == nil || block["type"] != "tool_use" {
			return nil, nil
		}
		input := map[string]any{}
		if raw := d.partialJSON[chunk.Index]; raw != "" {
			// A malformed argument blob is the model's problem, not a reason
			// to abandon the stream; the tool will refuse it.
			_ = json.Unmarshal([]byte(raw), &input)
		}
		block["input"] = input
		return []Event{{
			Type:  "tool_call",
			ID:    str(block["id"]),
			Name:  str(block["name"]),
			Input: input,
		}}, nil

	case "message_delta":
		return []Event{{
			Type:       "meta",
			StopReason: chunk.Delta.StopReason,
			Usage:      &Usage{Input: d.inputTokens, Output: chunk.Usage.OutputTokens},
		}}, nil

	case "error":
		message := chunk.Error.Message
		if message == "" {
			message = "upstream error"
		}
		return []Event{ErrorEvent("%s", message)}, nil
	}
	return nil, nil
}

func (d *anthropicDecoder) AssistantTurn() []any {
	content := make([]any, 0, len(d.blocks))
	for _, block := range d.blocks {
		if block != nil {
			content = append(content, block)
		}
	}
	if len(content) == 0 {
		return nil
	}
	return []any{map[string]any{"role": "assistant", "content": content}}
}

func (d *anthropicDecoder) ResultTurn(results []ToolResult) []any {
	blocks := make([]any, len(results))
	for i, result := range results {
		blocks[i] = map[string]any{
			"type":        "tool_result",
			"tool_use_id": result.ID,
			"content":     result.Content,
			"is_error":    !result.OK,
		}
	}
	return []any{map[string]any{"role": "user", "content": blocks}}
}

// str reads a string out of the decoded JSON, tolerating a key that is absent
// or of another type.
func str(value any) string {
	text, _ := value.(string)
	return text
}
