// Package tools holds the registry the model can call.
//
// A tool declares its schema, the scope it belongs to, whether it is available
// under the current configuration, and how to run it. Availability is part of
// the declaration rather than a check at the call site: a tool whose backing
// credential is missing is never offered to the model, instead of being
// offered and always failing.
package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"time"
)

// Scopes are the unit of authorization, split by blast radius rather than by
// subject matter. A consent screen that says "GitHub write" means something;
// one that says "tools" does not.
const (
	ScopeToolsRead   = "tools:read"
	ScopeMemoryRead  = "memory:read"
	ScopeMemoryWrite = "memory:write"
	ScopeGitHubWrite = "github:write"
)

// ScopeDescriptions is what a person reads when deciding.
var ScopeDescriptions = map[string]string{
	ScopeToolsRead:   "Fetch web pages, search, check the time, and ask other models",
	ScopeMemoryRead:  "Read your saved notes",
	ScopeMemoryWrite: "Save and delete your notes",
	ScopeGitHubWrite: "Commit to branches and open pull requests",
}

// ScopeOrder fixes the order scopes are shown and listed in, so a consent
// screen does not shuffle between visits.
var ScopeOrder = []string{ScopeToolsRead, ScopeMemoryRead, ScopeMemoryWrite, ScopeGitHubWrite}

// Result is what a tool produced. A refusal is a Result with OK false, not an
// error: the model is meant to read it and adapt. An error return is reserved
// for the machinery failing.
type Result struct {
	OK      bool
	Content string
}

func ok(format string, args ...any) Result {
	return Result{OK: true, Content: fmt.Sprintf(format, args...)}
}

func refuse(format string, args ...any) Result {
	return Result{OK: false, Content: fmt.Sprintf(format, args...)}
}

// Tool is one callable.
type Tool struct {
	Name  string
	Scope string
	// NeedsApproval marks a tool that should be confirmed before it runs, on
	// a transport that can carry an answer back mid-turn.
	NeedsApproval bool
	// Describe returns the description and schema. It takes the environment
	// because some descriptions depend on it — which providers ask_model can
	// reach, which hosts fetch_url is authenticated for.
	Describe func(env *Env) (description string, schema map[string]any)
	// Available reports whether configuration allows this tool at all.
	Available func(env *Env) bool
	// Summarize labels a call for the transcript.
	Summarize func(input map[string]any) string
	Run       func(ctx context.Context, input map[string]any, env *Env) Result
}

// Spec is a tool as the model sees it.
type Spec struct {
	Name        string         `json:"name"`
	Scope       string         `json:"scope"`
	Description string         `json:"description"`
	Schema      map[string]any `json:"inputSchema"`
}

// Env is everything the tools are allowed to see. It is assembled by the
// server so that the only secrets reaching a tool are the ones it needs: a
// credential says which hosts it may go to, and ask_model gets a narrow
// callback rather than the key ring.
type Env struct {
	HTTP *http.Client

	// SelfHost is this service's own hostname, refused by fetch_url so the
	// model cannot make the server talk to itself.
	SelfHost string

	Credentials []Credential
	Search      *SearchConfig
	GitHub      *GitHubConfig
	Memory      *MemoryStore

	// AskableProviders is the set ask_model may reach.
	AskableProviders []string
	AskModel         func(ctx context.Context, provider, model, prompt string) Result
}

// Credential is an outbound authorization that may only be sent to named
// hosts. fetch_url goes wherever the model points it, so a header attached
// unconditionally would be handed to any host it visits.
type Credential struct {
	Label   string
	Hosts   []string
	Headers map[string]string
}

type SearchConfig struct {
	Kind string // "brave" or "tavily"
	Key  string
}

type GitHubConfig struct {
	Token string
}

// Registry is the ordered set of tools.
type Registry struct {
	tools  []*Tool
	byName map[string]*Tool
}

func NewRegistry() *Registry {
	all := []*Tool{
		fetchURLTool(),
		webSearchTool(),
		currentTimeTool(),
		askModelTool(),
		githubWriteFileTool(),
		githubOpenPRTool(),
		saveMemoryTool(),
		readMemoryTool(),
		listMemoriesTool(),
		deleteMemoryTool(),
	}
	registry := &Registry{tools: all, byName: make(map[string]*Tool, len(all))}
	for _, tool := range all {
		registry.byName[tool.Name] = tool
	}
	return registry
}

// Available lists the tools this configuration offers, filtered to the granted
// scopes. An empty scope set permits nothing rather than everything: a caller
// must never reach the registry by failing to present a grant.
func (r *Registry) Available(env *Env, scopes []string) []Spec {
	granted := map[string]bool{}
	for _, scope := range scopes {
		granted[scope] = true
	}

	var specs []Spec
	for _, tool := range r.tools {
		if !tool.Available(env) || !granted[tool.Scope] {
			continue
		}
		description, schema := tool.Describe(env)
		specs = append(specs, Spec{
			Name:        tool.Name,
			Scope:       tool.Scope,
			Description: description,
			Schema:      schema,
		})
	}
	return specs
}

// AllScopes is every scope, for a caller acting as the account holder.
func AllScopes() []string {
	scopes := make([]string, len(ScopeOrder))
	copy(scopes, ScopeOrder)
	return scopes
}

// Lookup finds a tool the caller is allowed to run.
func (r *Registry) Lookup(name string, env *Env, scopes []string) (*Tool, bool) {
	tool, ok := r.byName[name]
	if !ok || !tool.Available(env) {
		return nil, false
	}
	for _, scope := range scopes {
		if scope == tool.Scope {
			return tool, true
		}
	}
	return nil, false
}

// Run executes a tool. Callers are expected to have gone through Lookup, so
// an unknown name here is a programming error rather than a refusal.
func (r *Registry) Run(ctx context.Context, tool *Tool, input map[string]any, env *Env) Result {
	// Every tool gets a deadline. Without one a slow upstream would hold the
	// whole turn open, and on Cloud Run that means holding a request slot.
	ctx, cancel := context.WithTimeout(ctx, toolTimeout)
	defer cancel()
	return tool.Run(ctx, input, env)
}

func (r *Registry) Summarize(name string, input map[string]any) string {
	if tool, ok := r.byName[name]; ok && tool.Summarize != nil {
		return tool.Summarize(input)
	}
	encoded, _ := json.Marshal(input)
	return string(encoded)
}

func (r *Registry) NeedsApproval(name string) bool {
	tool, ok := r.byName[name]
	return ok && tool.NeedsApproval
}

// ScopesFor returns the scopes present in a set of specs, ordered.
func ScopesFor(specs []Spec) []string {
	seen := map[string]bool{}
	for _, spec := range specs {
		seen[spec.Scope] = true
	}
	var scopes []string
	for _, scope := range ScopeOrder {
		if seen[scope] {
			scopes = append(scopes, scope)
		}
	}
	sort.SliceStable(scopes, func(i, j int) bool { return false })
	return scopes
}

const toolTimeout = 20 * time.Second

// stringArg pulls a trimmed string argument, since models produce all three of
// a missing key, a null, and a number where a string was asked for.
func stringArg(input map[string]any, key string) string {
	value, _ := input[key].(string)
	return trimSpace(value)
}
