package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const searchResults = 6

// ---------- web_search ----------

// Two interchangeable backends, picked by whichever key is configured — the
// same reasoning as the chat providers: no reason to hard-wire one vendor.
func webSearchTool() *Tool {
	return &Tool{
		Name:      "web_search",
		Scope:     ScopeToolsRead,
		Available: func(env *Env) bool { return env.Search != nil },
		Summarize: func(input map[string]any) string { return stringArg(input, "query") },
		Describe: func(*Env) (string, map[string]any) {
			return "Search the web and return the top results as title, URL, and snippet. Use it " +
					"when you need current information and do not already know which page to read; " +
					"follow up with fetch_url to read a result in full.",
				map[string]any{
					"type": "object",
					"properties": map[string]any{
						"query": map[string]any{"type": "string", "description": "The search query."},
					},
					"required": []string{"query"},
				}
		},
		Run: webSearch,
	}
}

type searchHit struct {
	Title   string
	URL     string
	Snippet string
}

func webSearch(ctx context.Context, input map[string]any, env *Env) Result {
	query := stringArg(input, "query")
	if query == "" {
		return refuse("Refused: no query was provided.")
	}
	if env.Search == nil {
		return refuse("Web search is not configured.")
	}

	var hits []searchHit
	var err error
	if env.Search.Kind == "tavily" {
		hits, err = tavilySearch(ctx, env, query)
	} else {
		hits, err = braveSearch(ctx, env, query)
	}
	if err != nil {
		return refuse("Search failed: %v", err)
	}
	if len(hits) == 0 {
		return ok("No results for %q.", query)
	}

	var body strings.Builder
	for i, hit := range hits {
		if i > 0 {
			body.WriteString("\n\n")
		}
		fmt.Fprintf(&body, "%d. %s\n   %s\n   %s",
			i+1, hit.Title, hit.URL, strings.Join(strings.Fields(hit.Snippet), " "))
	}

	// Titles and snippets are attacker-controlled too, so they carry the same
	// warning as a fetched page.
	return ok("Results for %q (via %s):\n\n%s\n\n---\n%s",
		query, env.Search.Kind, untrustedNotice, truncate(body.String()))
}

func braveSearch(ctx context.Context, env *Env, query string) ([]searchHit, error) {
	endpoint := fmt.Sprintf(
		"https://api.search.brave.com/res/v1/web/search?q=%s&count=%d",
		url.QueryEscape(query), searchResults)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("X-Subscription-Token", env.Search.Key)

	resp, err := env.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("Brave Search returned %d", resp.StatusCode)
	}

	var payload struct {
		Web struct {
			Results []struct {
				Title       string `json:"title"`
				URL         string `json:"url"`
				Description string `json:"description"`
			} `json:"results"`
		} `json:"web"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, err
	}
	hits := make([]searchHit, 0, len(payload.Web.Results))
	for _, result := range payload.Web.Results {
		hits = append(hits, searchHit{result.Title, result.URL, result.Description})
	}
	return hits, nil
}

func tavilySearch(ctx context.Context, env *Env, query string) ([]searchHit, error) {
	body, err := json.Marshal(map[string]any{"query": query, "max_results": searchResults})
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		"https://api.tavily.com/search", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+env.Search.Key)

	resp, err := env.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("Tavily returned %d", resp.StatusCode)
	}

	var payload struct {
		Results []struct {
			Title   string `json:"title"`
			URL     string `json:"url"`
			Content string `json:"content"`
		} `json:"results"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, err
	}
	hits := make([]searchHit, 0, len(payload.Results))
	for _, result := range payload.Results {
		hits = append(hits, searchHit{result.Title, result.URL, result.Content})
	}
	return hits, nil
}

// ---------- get_current_time ----------

func currentTimeTool() *Tool {
	return &Tool{
		Name:      "get_current_time",
		Scope:     ScopeToolsRead,
		Available: func(*Env) bool { return true },
		Summarize: func(input map[string]any) string {
			if zone := stringArg(input, "timezone"); zone != "" {
				return zone
			}
			return "UTC"
		},
		Describe: func(*Env) (string, map[string]any) {
			return "Get the current date and time. Use it whenever the answer depends on what " +
					"today is — you have no other way to know it.",
				map[string]any{
					"type": "object",
					"properties": map[string]any{
						"timezone": map[string]any{
							"type":        "string",
							"description": `Optional IANA time zone name, e.g. "America/New_York". Defaults to UTC.`,
						},
					},
					"required": []string{},
				}
		},
		Run: func(_ context.Context, input map[string]any, _ *Env) Result {
			zone := stringArg(input, "timezone")
			if zone == "" {
				zone = "UTC"
			}
			location, err := time.LoadLocation(zone)
			if err != nil {
				return refuse("%q is not a recognised IANA time zone name.", zone)
			}
			now := time.Now()
			return ok("%s\nUTC: %s",
				now.In(location).Format("Monday, January 2, 2006 at 3:04:05 PM MST"),
				now.UTC().Format(time.RFC3339))
		},
	}
}

// ---------- ask_model ----------

func askModelTool() *Tool {
	return &Tool{
		Name:  "ask_model",
		Scope: ScopeToolsRead,
		Available: func(env *Env) bool {
			return env.AskModel != nil && len(env.AskableProviders) > 0
		},
		Summarize: func(input map[string]any) string {
			provider := stringArg(input, "provider")
			if provider == "" {
				provider = "?"
			}
			if model := stringArg(input, "model"); model != "" {
				return provider + "/" + model
			}
			return provider
		},
		Describe: func(env *Env) (string, map[string]any) {
			return "Ask a different language model a one-off question and return its answer. Use " +
					"it for a second opinion, or to compare how another model responds. The other " +
					"model sees only the prompt you send — it has no memory of this conversation " +
					"and no tools of its own.",
				map[string]any{
					"type": "object",
					"properties": map[string]any{
						"provider": map[string]any{
							"type":        "string",
							"enum":        env.AskableProviders,
							"description": "Which provider to ask.",
						},
						"model": map[string]any{
							"type":        "string",
							"description": "Model id for that provider. Omit to use the provider's default.",
						},
						"prompt": map[string]any{
							"type":        "string",
							"description": "The self-contained question. Include any context it needs.",
						},
					},
					"required": []string{"provider", "prompt"},
				}
		},
		Run: func(ctx context.Context, input map[string]any, env *Env) Result {
			prompt := stringArg(input, "prompt")
			if prompt == "" {
				return refuse("Refused: no prompt was provided.")
			}
			if env.AskModel == nil {
				return refuse("No other models are configured.")
			}
			return env.AskModel(ctx, stringArg(input, "provider"), stringArg(input, "model"), prompt)
		},
	}
}
