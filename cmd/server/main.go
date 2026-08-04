// Command server runs the LLM playground.
//
// It is the Cloudflare Worker rebuilt for Cloud Run. The shape survives the
// move — provider adapters behind one interface, a tool registry gated by
// configuration and scopes, an agent loop that streams normalized events — but
// three things could not come across as they were: KV is now a REST client
// rather than a binding, HTML is reduced with a tokenizer rather than
// HTMLRewriter, and Cloudflare Access is no longer standing in front of the
// process, so verifying its token is the only thing gating a private route.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/timgcavell/llm-playground/internal/access"
	"github.com/timgcavell/llm-playground/internal/agent"
	"github.com/timgcavell/llm-playground/internal/kv"
	"github.com/timgcavell/llm-playground/internal/mcp"
	"github.com/timgcavell/llm-playground/internal/providers"
	"github.com/timgcavell/llm-playground/internal/tools"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(logger)

	server, err := newServer()
	if err != nil {
		logger.Error("startup failed", "error", err)
		os.Exit(1)
	}

	// Cloud Run tells the container which port to listen on; it is not ours
	// to choose.
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	httpServer := &http.Server{
		Addr:    ":" + port,
		Handler: server.routes(),
		// No write timeout: a streamed turn can legitimately run for minutes,
		// and a deadline here would cut the response mid-answer. Per-turn
		// limits live in the agent and the tools instead.
		ReadHeaderTimeout: 15 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	// Cloud Run sends SIGTERM and then waits; draining in-flight turns rather
	// than dropping them is the difference between a deploy nobody notices and
	// one that truncates someone's answer.
	shutdown := make(chan os.Signal, 1)
	signal.Notify(shutdown, syscall.SIGTERM, syscall.SIGINT)

	go func() {
		logger.Info("listening", "port", port, "origin", server.publicOrigin)
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("server failed", "error", err)
			os.Exit(1)
		}
	}()

	<-shutdown
	logger.Info("draining")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(ctx); err != nil {
		logger.Error("shutdown", "error", err)
	}
}

type server struct {
	providers    *providers.Registry
	registry     *tools.Registry
	runner       *agent.Runner
	mcp          *mcp.Server
	verifier     *access.Verifier
	memoryKV     *kv.Store
	publicOrigin string
	staticDir    string
	localDev     bool
}

func newServer() (*server, error) {
	registry := tools.NewRegistry()
	providerRegistry := providers.NewRegistry(os.Getenv)

	// One client for tool traffic, with the guarded dialer that refuses to
	// connect to private addresses. On Workers, egress went straight to the
	// public internet; here the container sits in a VPC with a metadata
	// server on it, so the guard is load-bearing rather than belt-and-braces.
	fetchClient := tools.NewFetchClient()

	srv := &server{
		providers: providerRegistry,
		registry:  registry,
		mcp:       &mcp.Server{Registry: registry},
		verifier: access.NewVerifier(
			envOr("CF_ACCESS_TEAM_DOMAIN", ""),
			envOr("CF_ACCESS_AUD", ""),
		),
		publicOrigin: envOr("PUBLIC_ORIGIN", ""),
		staticDir:    envOr("STATIC_DIR", "./public"),
		localDev:     os.Getenv("LOCAL_DEV") == "1",
	}

	srv.runner = &agent.Runner{
		Registry: registry,
		HTTP:     &http.Client{}, // no timeout: turns are long, ctx bounds them
	}

	if account, namespace := os.Getenv("CF_ACCOUNT_ID"), os.Getenv("CF_KV_NAMESPACE_ID"); account != "" && namespace != "" {
		store, err := kv.New(kv.Config{
			AccountID:   account,
			NamespaceID: namespace,
			APIToken:    os.Getenv("CF_KV_API_TOKEN"),
		})
		if err != nil {
			return nil, err
		}
		srv.memoryKV = store
	}

	srv.runner.Env = srv.toolEnv(fetchClient, "")
	return srv, nil
}

// toolEnv assembles what the tools may see for one caller. Secrets are turned
// into narrow capabilities here — a credential says which hosts it may go to,
// and ask_model gets a callback rather than the key ring.
func (s *server) toolEnv(client *http.Client, owner string) *tools.Env {
	env := &tools.Env{
		HTTP:             client,
		SelfHost:         hostOf(s.publicOrigin),
		AskableProviders: s.providers.Names(),
	}

	if token := os.Getenv("GITHUB_API_KEY"); token != "" {
		env.GitHub = &tools.GitHubConfig{Token: token}
		env.Credentials = append(env.Credentials, tools.Credential{
			Label:   "GitHub",
			Hosts:   []string{"api.github.com", "raw.githubusercontent.com"},
			Headers: map[string]string{"Authorization": "Bearer " + token},
		})
	}
	if key := os.Getenv("BRAVE_SEARCH_API_KEY"); key != "" {
		env.Search = &tools.SearchConfig{Kind: "brave", Key: key}
	} else if key := os.Getenv("TAVILY_API_KEY"); key != "" {
		env.Search = &tools.SearchConfig{Kind: "tavily", Key: key}
	}
	if s.memoryKV != nil && owner != "" {
		env.Memory = &tools.MemoryStore{KV: kvAdapter{s.memoryKV}, Owner: owner}
	}

	env.AskModel = func(ctx context.Context, name, model, prompt string) tools.Result {
		provider, ok := s.providers.Get(name)
		if !ok {
			return tools.Result{Content: "Unknown provider: " + name}
		}
		if model == "" && len(provider.Models()) > 0 {
			model = provider.Models()[0].ID
		}
		answer, err := s.runner.Once(ctx, agent.Request{
			Provider:  provider,
			APIKey:    os.Getenv(provider.KeyEnv()),
			Model:     model,
			Caps:      providers.CapsFor(provider, model),
			Messages:  []providers.Message{{Role: "user", Content: prompt}},
			MaxTokens: 2000,
		})
		if err != nil {
			return tools.Result{Content: err.Error()}
		}
		if answer == "" {
			answer = "(the model returned no text)"
		}
		return tools.Result{OK: true, Content: provider.Label() + " / " + model + ":\n\n" + answer}
	}
	return env
}

// kvAdapter narrows the KV client to what the memory tools declared they need,
// translating the store's sentinel error into the explicit found bool that
// interface asks for.
type kvAdapter struct{ store *kv.Store }

func (a kvAdapter) Get(ctx context.Context, key string) ([]byte, bool, error) {
	value, err := a.store.Get(ctx, key)
	if errors.Is(err, kv.ErrNotFound) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return value, true, nil
}

func (a kvAdapter) Put(ctx context.Context, key string, value []byte) error {
	return a.store.Put(ctx, key, value)
}

func (a kvAdapter) Delete(ctx context.Context, key string) error {
	return a.store.Delete(ctx, key)
}

func (a kvAdapter) List(ctx context.Context, prefix string, limit int) ([]string, error) {
	return a.store.List(ctx, prefix, limit)
}

func (s *server) routes() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	mux.HandleFunc("GET /api/providers", s.gated(s.handleProviders))
	mux.HandleFunc("POST /api/chat", s.gated(s.handleChat))
	mux.HandleFunc("/api/mcp", s.gated(s.handleMCP))

	// Static files are matched last, so an unknown /api path is a 404 rather
	// than the app shell.
	files := http.FileServer(http.Dir(s.staticDir))
	mux.Handle("/", spaFallback(s.staticDir, files))

	return logRequests(mux)
}

// identify resolves who is calling. With no Access audience configured this
// refuses unless LOCAL_DEV is set, because a deployed service with nothing
// verifying identity is an open proxy in front of paid API keys.
func (s *server) identify(r *http.Request) (access.Identity, error) {
	if !s.verifier.Configured() {
		if s.localDev {
			return access.Identity{Subject: "local@dev", Email: "local@dev"}, nil
		}
		return access.Identity{}, errors.New("Cloudflare Access is not configured")
	}
	return s.verifier.Verify(r.Context(), r)
}

type handlerWithIdentity func(http.ResponseWriter, *http.Request, access.Identity)

func (s *server) gated(next handlerWithIdentity) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		identity, err := s.identify(r)
		if err != nil {
			status := http.StatusUnauthorized
			if errors.Is(err, access.ErrNoToken) {
				status = http.StatusUnauthorized
			}
			writeJSON(w, status, map[string]any{"error": "Unauthorized"})
			return
		}
		next(w, r, identity)
	}
}

func (s *server) handleProviders(w http.ResponseWriter, r *http.Request, identity access.Identity) {
	env := s.toolEnv(s.runner.Env.HTTP, identity.Subject)
	specs := s.registry.Available(env, tools.AllScopes())

	described := make([]map[string]any, 0, 3)
	for _, provider := range []providers.Provider{&providers.Anthropic{}, &providers.Google{}, &providers.OpenAI{}} {
		_, configured := s.providers.Get(provider.Name())
		described = append(described, map[string]any{
			"id":         provider.Name(),
			"label":      provider.Label(),
			"configured": configured,
			"keyVar":     provider.KeyEnv(),
			"models":     provider.Models(),
		})
	}

	listed := make([]map[string]string, len(specs))
	for i, spec := range specs {
		listed[i] = map[string]string{"name": spec.Name, "description": spec.Description}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"email":     identity.Subject,
		"providers": described,
		"tools":     listed,
	})
}

func (s *server) handleMCP(w http.ResponseWriter, r *http.Request, identity access.Identity) {
	env := s.toolEnv(s.runner.Env.HTTP, identity.Subject)
	s.mcp.Handle(w, r, env, tools.AllScopes())
}

type chatRequest struct {
	Provider    string              `json:"provider"`
	Model       string              `json:"model"`
	System      string              `json:"system"`
	Messages    []providers.Message `json:"messages"`
	Temperature *float64            `json:"temperature"`
	MaxTokens   int                 `json:"maxTokens"`
	Tools       bool                `json:"tools"`
}

const (
	maxMessages    = 200
	maxChars       = 200_000
	maxOutputCap   = 128_000
	defaultOutputs = 32_000
)

func (c chatRequest) validate(registry *providers.Registry) (providers.Provider, error) {
	provider, ok := registry.Get(c.Provider)
	if !ok {
		return nil, errors.New("Unknown or unconfigured provider: " + c.Provider)
	}
	if strings.TrimSpace(c.Model) == "" || len(c.Model) > 200 {
		return nil, errors.New("A model id is required")
	}
	if len(c.Messages) == 0 {
		return nil, errors.New("At least one message is required")
	}
	if len(c.Messages) > maxMessages {
		return nil, errors.New("At most " + strconv.Itoa(maxMessages) + " messages")
	}
	total := 0
	for _, message := range c.Messages {
		if message.Role != "user" && message.Role != "assistant" {
			return nil, errors.New("Each message needs a role of 'user' or 'assistant'")
		}
		if message.Content == "" {
			return nil, errors.New("Each message needs non-empty string content")
		}
		total += len(message.Content)
	}
	if total > maxChars {
		return nil, errors.New("Conversation is too long to send")
	}
	if c.Temperature != nil && (*c.Temperature < 0 || *c.Temperature > 2) {
		return nil, errors.New("Temperature must be between 0 and 2")
	}
	if c.MaxTokens < 0 || c.MaxTokens > maxOutputCap {
		return nil, errors.New("maxTokens is out of range")
	}
	return provider, nil
}

func (s *server) handleChat(w http.ResponseWriter, r *http.Request, identity access.Identity) {
	var body chatRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<20)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Invalid JSON"})
		return
	}
	provider, err := body.validate(s.providers)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	if body.MaxTokens == 0 {
		body.MaxTokens = defaultOutputs
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "Streaming unsupported"})
		return
	}

	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	events := make(chan providers.Event, 32)
	runner := &agent.Runner{
		Registry: s.registry,
		Env:      s.toolEnv(s.runner.Env.HTTP, identity.Subject),
		HTTP:     s.runner.HTTP,
	}

	go runner.Run(r.Context(), agent.Request{
		Provider:    provider,
		APIKey:      os.Getenv(provider.KeyEnv()),
		Model:       body.Model,
		Caps:        providers.CapsFor(provider, body.Model),
		System:      strings.TrimSpace(body.System),
		Messages:    body.Messages,
		Temperature: body.Temperature,
		MaxTokens:   body.MaxTokens,
		UseTools:    body.Tools,
		Scopes:      tools.AllScopes(),
		// No approve or continue hook: this response only flows one way, so
		// there is nowhere for the browser to answer a question mid-turn.
	}, events)

	encoder := json.NewEncoder(w)
	for event := range events {
		if _, err := w.Write([]byte("data: ")); err != nil {
			return
		}
		if err := encoder.Encode(event); err != nil {
			return
		}
		if _, err := w.Write([]byte("\n")); err != nil {
			return
		}
		flusher.Flush()
	}

	_, _ = w.Write([]byte("data: {\"type\":\"done\"}\n\n"))
	flusher.Flush()
}

// spaFallback serves index.html for paths with no file behind them, so a deep
// link into the client-side app still renders.
func spaFallback(dir string, files http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			http.NotFound(w, r)
			return
		}
		if _, err := os.Stat(dir + r.URL.Path); err == nil || r.URL.Path == "/" {
			files.ServeHTTP(w, r)
			return
		}
		http.ServeFile(w, r, dir+"/index.html")
	})
}

func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		next.ServeHTTP(w, r)
		slog.Info("request",
			"method", r.Method, "path", r.URL.Path, "duration", time.Since(started).String())
	})
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func envOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func hostOf(origin string) string {
	origin = strings.TrimPrefix(strings.TrimPrefix(origin, "https://"), "http://")
	if index := strings.IndexAny(origin, "/:"); index >= 0 {
		return origin[:index]
	}
	return origin
}
