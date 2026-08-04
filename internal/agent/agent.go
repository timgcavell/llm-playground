// Package agent runs one conversational turn.
//
// Without tools that is a single upstream call piped through. With them it
// becomes a loop: stream a turn, run whatever tools the model asked for, hand
// the results back, stream the next turn. Callers see one continuous sequence
// of events either way, so a tool call is a rendering detail rather than a
// protocol change.
//
// The Worker version threaded an `emit` callback through every layer. Here
// events go out on a channel, which is the same idea with Go's grain: the
// caller ranges over it, cancellation arrives through the context, and the
// loop cannot outlive the request that started it.
package agent

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"

	"github.com/timgcavell/llm-playground/internal/providers"
	"github.com/timgcavell/llm-playground/internal/tools"
)

// MaxToolRounds bounds one send. Each round is another upstream call, so this
// caps both cost and latency. On a transport that can ask, exhausting it
// offers to continue; elsewhere the turn stops.
const MaxToolRounds = 5

// Request is one turn.
type Request struct {
	Provider    providers.Provider
	APIKey      string
	Model       string
	Caps        providers.Caps
	System      string
	Messages    []providers.Message
	Temperature *float64
	MaxTokens   int

	// UseTools enables the registry for this turn.
	UseTools bool
	Scopes   []string

	// Approve is consulted before a tool that needs confirmation runs. Nil on
	// a transport that cannot carry an answer back, in which case such tools
	// run — which is why they are also narrow by design.
	Approve func(ctx context.Context, call Call) bool
	// AskContinue is consulted when the round budget runs out. Nil means stop.
	AskContinue func(ctx context.Context, rounds int) bool
}

// Call is a tool invocation awaiting a decision.
type Call struct {
	ID      string
	Name    string
	Summary string
	Input   map[string]any
}

// Runner holds what every turn needs.
type Runner struct {
	Registry *tools.Registry
	Env      *tools.Env
	HTTP     *http.Client
}

// Run streams the turn's events into out, closing it when the turn ends.
// Cancelling ctx stops the upstream request and unwinds the loop.
func (r *Runner) Run(ctx context.Context, req Request, out chan<- providers.Event) {
	defer close(out)

	emit := func(event providers.Event) bool {
		select {
		case out <- event:
			return true
		case <-ctx.Done():
			return false
		}
	}

	var specs []tools.Spec
	if req.UseTools {
		specs = r.Registry.Available(r.Env, req.Scopes)
	}
	toolSpecs := make([]providers.ToolSpec, len(specs))
	for i, spec := range specs {
		toolSpecs[i] = providers.ToolSpec{
			Name:        spec.Name,
			Description: spec.Description,
			Schema:      spec.Schema,
		}
	}

	var extra []any
	budget := MaxToolRounds

	for round := 0; ; round++ {
		decoder := req.Provider.NewDecoder()
		var calls []Call

		upstream := providers.Request{
			APIKey:      req.APIKey,
			Model:       req.Model,
			Caps:        req.Caps,
			System:      req.System,
			Messages:    req.Messages,
			Temperature: req.Temperature,
			MaxTokens:   req.MaxTokens,
			Tools:       toolSpecs,
			Extra:       extra,
		}

		httpReq, err := req.Provider.Build(upstream)
		if err != nil {
			emit(providers.ErrorEvent("Could not build the request: %v", err))
			return
		}
		httpReq = httpReq.WithContext(ctx)

		resp, err := r.HTTP.Do(httpReq)
		if err != nil {
			if errors.Is(err, context.Canceled) {
				return
			}
			emit(providers.ErrorEvent("%s could not be reached: %v", req.Provider.Label(), err))
			return
		}

		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			detail := upstreamError(resp)
			resp.Body.Close()
			emit(providers.ErrorEvent("%s returned %d: %s", req.Provider.Label(), resp.StatusCode, detail))
			return
		}

		err = consumeSSE(ctx, resp.Body, func(payload []byte) bool {
			events, err := decoder.Decode(payload)
			if err != nil {
				// A payload we cannot parse is not worth killing the stream
				// over; the model's own output is still flowing.
				return true
			}
			for _, event := range events {
				if event.Type == "tool_call" {
					summary := r.Registry.Summarize(event.Name, event.Input)
					calls = append(calls, Call{
						ID: event.ID, Name: event.Name, Summary: summary, Input: event.Input,
					})
					event.Summary = summary
				}
				if event.Type == "meta" {
					// Usage is reported per upstream call, and some providers
					// restate a running total on every chunk. Tagging the
					// round lets the client overwrite within a round and add
					// up across rounds, instead of summing restatements.
					current := round
					event.Round = &current
				}
				if !emit(event) {
					return false
				}
			}
			return true
		})
		resp.Body.Close()
		if err != nil && !errors.Is(err, context.Canceled) {
			emit(providers.ErrorEvent("The stream ended early: %v", err))
			return
		}

		// No tool calls means the model is done talking.
		if len(calls) == 0 {
			return
		}

		if round >= budget-1 {
			// The model wants more rounds than the budget allows. Where the
			// transport can carry an answer, ask; a decline, or no way to
			// ask, ends the turn with these calls unrun.
			if req.AskContinue == nil || !req.AskContinue(ctx, budget) {
				emit(providers.ErrorEvent("Stopped after %d rounds of tool calls.", budget))
				return
			}
			budget += MaxToolRounds
		}

		results := r.runCalls(ctx, req, calls, emit)
		if results == nil {
			return
		}
		extra = append(extra, decoder.AssistantTurn()...)
		extra = append(extra, decoder.ResultTurn(results)...)
	}
}

// runCalls executes a round's tools concurrently, reporting each result as it
// lands rather than when the whole batch settles — one call waiting on an
// approval should not leave its finished siblings looking stuck.
//
// Results come back in call order regardless of completion order, because the
// order they are handed to the model has to match the calls they answer.
func (r *Runner) runCalls(
	ctx context.Context,
	req Request,
	calls []Call,
	emit func(providers.Event) bool,
) []providers.ToolResult {
	results := make([]providers.ToolResult, len(calls))
	var mu sync.Mutex
	var wait sync.WaitGroup

	for i, call := range calls {
		wait.Add(1)
		go func(index int, call Call) {
			defer wait.Done()

			var result tools.Result
			tool, allowed := r.Registry.Lookup(call.Name, r.Env, req.Scopes)
			switch {
			case !allowed:
				result = tools.Result{OK: false, Content: "Unknown tool: " + call.Name}
			// Destructive tools are held until the user answers — but only on
			// a transport that can carry an answer.
			case tool.NeedsApproval && req.Approve != nil && !req.Approve(ctx, call):
				result = tools.Result{OK: false, Content: "The user declined to run this tool."}
			default:
				result = r.Registry.Run(ctx, tool, call.Input, r.Env)
			}

			mu.Lock()
			results[index] = providers.ToolResult{
				ID: call.ID, Name: call.Name, OK: result.OK, Content: result.Content,
			}
			mu.Unlock()

			okValue := result.OK
			emit(providers.Event{
				Type:    "tool_result",
				ID:      call.ID,
				Name:    call.Name,
				OK:      &okValue,
				Summary: call.Summary,
				Content: result.Content,
			})
		}(i, call)
	}

	wait.Wait()
	if ctx.Err() != nil {
		return nil
	}
	return results
}

// Once runs a single prompt with no history and no tools. This backs the
// ask_model tool: the model being asked cannot call tools of its own, which is
// also what stops two models from calling each other in a loop.
func (r *Runner) Once(ctx context.Context, req Request) (string, error) {
	httpReq, err := req.Provider.Build(providers.Request{
		APIKey:    req.APIKey,
		Model:     req.Model,
		Caps:      req.Caps,
		Messages:  req.Messages,
		MaxTokens: req.MaxTokens,
	})
	if err != nil {
		return "", err
	}

	resp, err := r.HTTP.Do(httpReq.WithContext(ctx))
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("%s returned %d: %s",
			req.Provider.Label(), resp.StatusCode, upstreamError(resp))
	}

	decoder := req.Provider.NewDecoder()
	var text strings.Builder
	err = consumeSSE(ctx, resp.Body, func(payload []byte) bool {
		events, err := decoder.Decode(payload)
		if err != nil {
			return true
		}
		for _, event := range events {
			if event.Type == "text" {
				text.WriteString(event.Text)
			}
		}
		return true
	})
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(text.String()), nil
}

// consumeSSE reads an event stream, handing each data payload to onPayload.
// Returning false stops the read, which is how a cancelled client unwinds the
// upstream request rather than draining it.
func consumeSSE(ctx context.Context, body io.Reader, onPayload func([]byte) bool) error {
	scanner := bufio.NewScanner(body)
	// Provider payloads routinely exceed bufio's 64KB default; a long tool
	// argument or a large content block would otherwise fail mid-stream.
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)

	var data []string
	flush := func() bool {
		if len(data) == 0 {
			return true
		}
		payload := strings.Join(data, "\n")
		data = data[:0]
		return onPayload([]byte(payload))
	}

	for scanner.Scan() {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		line := strings.TrimSuffix(scanner.Text(), "\r")
		switch {
		case line == "":
			if !flush() {
				return nil
			}
		case strings.HasPrefix(line, "data:"):
			data = append(data, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		}
		// event:, id:, and comments carry nothing this needs.
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	flush()
	return nil
}

// upstreamError pulls a readable message out of a provider's error body. All
// three report failures as {"error": {"message": ...}}.
func upstreamError(resp *http.Response) string {
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 8*1024))
	if err != nil {
		return err.Error()
	}
	var envelope struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
		Message string `json:"message"`
	}
	if json.Unmarshal(raw, &envelope) == nil {
		if envelope.Error.Message != "" {
			return envelope.Error.Message
		}
		if envelope.Message != "" {
			return envelope.Message
		}
	}
	return strings.TrimSpace(string(raw))
}
