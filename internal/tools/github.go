package tools

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

// The GitHub write tools. The guardrail is that the default branch is refused
// outright — there is no way to ask for a direct commit to it. The model
// proposes on a branch, and the human reviews and merges in GitHub, where the
// diff view is. Everything these tools can do is undoable from there: delete
// the branch, close the pull request.

const (
	githubAPI    = "https://api.github.com"
	maxFileChars = 100_000
	maxPathChars = 500
	repoRule     = `Repositories are named "owner/name".`
)

var repoPattern = regexp.MustCompile(`^[\w.-]+/[\w.-]+$`)

func hasGitHub(env *Env) bool { return env.GitHub != nil }

func normalizeRepo(raw string) (string, bool) {
	repo := trimSpace(raw)
	return repo, repoPattern.MatchString(repo)
}

func normalizeRepoPath(raw string) (string, bool) {
	path := strings.TrimLeft(trimSpace(raw), "/")
	if path == "" || len(path) > maxPathChars {
		return "", false
	}
	for _, segment := range strings.Split(path, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return "", false
		}
	}
	return path, true
}

func encodeRepoPath(path string) string {
	segments := strings.Split(path, "/")
	for i, segment := range segments {
		segments[i] = url.PathEscape(segment)
	}
	return strings.Join(segments, "/")
}

// githubResponse is one API call's outcome. Status is kept so callers can tell
// "absent" from "failed" — creating a file and updating one differ only by
// whether the read before it 404s. The body stays raw because the contents
// endpoint answers with an object for a file and an array for a directory, and
// decoding straight into a map would turn that distinction into an empty map.
type githubResponse struct {
	Status int
	Raw    []byte
	Body   map[string]any
}

// isArray reports a JSON array body — how the contents endpoint says
// "that path is a directory".
func (r githubResponse) isArray() bool {
	trimmed := bytes.TrimLeft(r.Raw, " \t\r\n")
	return len(trimmed) > 0 && trimmed[0] == '['
}

func (r githubResponse) ok() bool { return r.Status >= 200 && r.Status < 300 }

func (r githubResponse) message() string {
	if errs, isArray := r.Body["errors"].([]any); isArray && len(errs) > 0 {
		if first, isMap := errs[0].(map[string]any); isMap {
			if text := str(first["message"]); text != "" {
				return text
			}
		}
	}
	if text := str(r.Body["message"]); text != "" {
		return text
	}
	return fmt.Sprintf("HTTP %d", r.Status)
}

func str(value any) string {
	text, _ := value.(string)
	return text
}

func githubRequest(ctx context.Context, env *Env, method, path string, body any) (githubResponse, error) {
	var payload *bytes.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return githubResponse{}, err
		}
		payload = bytes.NewReader(encoded)
	} else {
		payload = bytes.NewReader(nil)
	}

	req, err := http.NewRequestWithContext(ctx, method, githubAPI+path, payload)
	if err != nil {
		return githubResponse{}, err
	}
	req.Header.Set("Authorization", "Bearer "+env.GitHub.Token)
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := env.HTTP.Do(req)
	if err != nil {
		return githubResponse{}, err
	}
	defer resp.Body.Close()

	decoded := githubResponse{Status: resp.StatusCode, Body: map[string]any{}}
	if resp.StatusCode != http.StatusNoContent {
		raw, err := io.ReadAll(io.LimitReader(resp.Body, maxBytes))
		if err != nil {
			return decoded, err
		}
		decoded.Raw = raw
		// A body that is not an object is not worth failing over; the status
		// and isArray still carry the outcome.
		_ = json.Unmarshal(raw, &decoded.Body)
	}
	return decoded, nil
}

func githubWriteFileTool() *Tool {
	return &Tool{
		Name:          "github_write_file",
		Scope:         ScopeGitHubWrite,
		NeedsApproval: true,
		Available:     hasGitHub,
		Summarize: func(input map[string]any) string {
			return fmt.Sprintf("%s %s:%s",
				orQuestion(stringArg(input, "repo")),
				orQuestion(stringArg(input, "branch")),
				orQuestion(stringArg(input, "path")))
		},
		Describe: func(*Env) (string, map[string]any) {
			return "Create or update one file in a GitHub repository, as a commit on a branch. " +
					"The default branch is refused — commit to a feature branch (created from the " +
					"default branch automatically if it doesn't exist) and then open a pull request " +
					"with github_open_pr. One file per call; call it repeatedly for multi-file " +
					"changes, reusing the same branch. Read files first via fetch_url.",
				map[string]any{
					"type": "object",
					"properties": map[string]any{
						"repo":    map[string]any{"type": "string", "description": `The repository, as "owner/name".`},
						"branch":  map[string]any{"type": "string", "description": "The branch to commit to. Never the default branch."},
						"path":    map[string]any{"type": "string", "description": "File path within the repository."},
						"content": map[string]any{"type": "string", "description": "The complete new contents of the file."},
						"message": map[string]any{"type": "string", "description": "The commit message."},
					},
					"required": []string{"repo", "branch", "path", "content", "message"},
				}
		},
		Run: githubWriteFile,
	}
}

func githubWriteFile(ctx context.Context, input map[string]any, env *Env) Result {
	repo, valid := normalizeRepo(stringArg(input, "repo"))
	if !valid {
		return refuse("Refused: invalid repository. %s", repoRule)
	}
	path, valid := normalizeRepoPath(stringArg(input, "path"))
	if !valid {
		return refuse("Refused: invalid file path.")
	}
	branch := stringArg(input, "branch")
	if branch == "" || len(branch) > 200 {
		return refuse("Refused: a branch name is required.")
	}
	message := stringArg(input, "message")
	if message == "" {
		return refuse("Refused: a commit message is required.")
	}
	content, _ := input["content"].(string)
	if len(content) > maxFileChars {
		return refuse("Refused: files are limited to %d characters.", maxFileChars)
	}

	meta, err := githubRequest(ctx, env, http.MethodGet, "/repos/"+repo, nil)
	if err != nil {
		return refuse("Looking up %s failed: %v", repo, err)
	}
	if !meta.ok() {
		return refuse("Looking up %s failed: %s", repo, meta.message())
	}
	defaultBranch := str(meta.Body["default_branch"])

	// The guardrail: no direct commits to the default branch, ever.
	if branch == defaultBranch {
		return refuse("Refused: %q is the default branch of %s. Commit to another branch and "+
			"open a pull request with github_open_pr instead.", branch, repo)
	}

	createdBranch := false
	ref, err := githubRequest(ctx, env, http.MethodGet,
		"/repos/"+repo+"/git/ref/heads/"+url.PathEscape(branch), nil)
	if err != nil {
		return refuse("Reading branch %s failed: %v", branch, err)
	}
	switch {
	case ref.Status == http.StatusNotFound:
		base, err := githubRequest(ctx, env, http.MethodGet,
			"/repos/"+repo+"/git/ref/heads/"+url.PathEscape(defaultBranch), nil)
		if err != nil || !base.ok() {
			return refuse("Reading %s failed: %s", defaultBranch, describe(err, base))
		}
		object, _ := base.Body["object"].(map[string]any)
		made, err := githubRequest(ctx, env, http.MethodPost, "/repos/"+repo+"/git/refs",
			map[string]any{"ref": "refs/heads/" + branch, "sha": str(object["sha"])})
		if err != nil || !made.ok() {
			return refuse("Creating branch %s failed: %s", branch, describe(err, made))
		}
		createdBranch = true
	case !ref.ok():
		return refuse("Reading branch %s failed: %s", branch, ref.message())
	}

	// Updating an existing file needs its current sha; a 404 means it is new.
	existing, err := githubRequest(ctx, env, http.MethodGet,
		"/repos/"+repo+"/contents/"+encodeRepoPath(path)+"?ref="+url.QueryEscape(branch), nil)
	if err != nil {
		return refuse("Reading %s failed: %v", path, err)
	}
	sha := ""
	if existing.ok() {
		if existing.isArray() {
			return refuse("Refused: %s is a directory.", path)
		}
		sha = str(existing.Body["sha"])
	}

	body := map[string]any{
		"message": message,
		"content": base64.StdEncoding.EncodeToString([]byte(content)),
		"branch":  branch,
	}
	if sha != "" {
		body["sha"] = sha
	}
	put, err := githubRequest(ctx, env, http.MethodPut,
		"/repos/"+repo+"/contents/"+encodeRepoPath(path), body)
	if err != nil || !put.ok() {
		return refuse("Committing %s failed: %s", path, describe(err, put))
	}

	commitSHA := "?"
	if commit, isMap := put.Body["commit"].(map[string]any); isMap {
		if full := str(commit["sha"]); len(full) >= 7 {
			commitSHA = full[:7]
		}
	}

	verb := "Created"
	if sha != "" {
		verb = "Updated"
	}
	note := ""
	if createdBranch {
		note = fmt.Sprintf(" (branch created from %s)", defaultBranch)
	}
	return ok("%s %s on %s@%s%s. Commit %s.", verb, path, repo, branch, note, commitSHA)
}

func githubOpenPRTool() *Tool {
	return &Tool{
		Name:          "github_open_pr",
		Scope:         ScopeGitHubWrite,
		NeedsApproval: true,
		Available:     hasGitHub,
		Summarize: func(input map[string]any) string {
			return fmt.Sprintf("%s %s",
				orQuestion(stringArg(input, "repo")), orQuestion(stringArg(input, "branch")))
		},
		Describe: func(*Env) (string, map[string]any) {
			return "Open a pull request from a branch to the repository's default branch. Use it " +
					"after committing changes with github_write_file, so the changes can be " +
					"reviewed and merged.",
				map[string]any{
					"type": "object",
					"properties": map[string]any{
						"repo":   map[string]any{"type": "string", "description": `The repository, as "owner/name".`},
						"branch": map[string]any{"type": "string", "description": "The branch with the changes."},
						"title":  map[string]any{"type": "string", "description": "Pull request title."},
						"body":   map[string]any{"type": "string", "description": "Optional pull request description."},
					},
					"required": []string{"repo", "branch", "title"},
				}
		},
		Run: func(ctx context.Context, input map[string]any, env *Env) Result {
			repo, valid := normalizeRepo(stringArg(input, "repo"))
			if !valid {
				return refuse("Refused: invalid repository. %s", repoRule)
			}
			head := stringArg(input, "branch")
			if head == "" {
				return refuse("Refused: a branch name is required.")
			}
			title := stringArg(input, "title")
			if title == "" {
				return refuse("Refused: a title is required.")
			}
			description, _ := input["body"].(string)

			meta, err := githubRequest(ctx, env, http.MethodGet, "/repos/"+repo, nil)
			if err != nil || !meta.ok() {
				return refuse("Looking up %s failed: %s", repo, describe(err, meta))
			}

			pr, err := githubRequest(ctx, env, http.MethodPost, "/repos/"+repo+"/pulls",
				map[string]any{
					"title": title,
					"head":  head,
					"base":  str(meta.Body["default_branch"]),
					"body":  description,
				})
			if err != nil {
				return refuse("Opening the pull request failed: %v", err)
			}
			if !pr.ok() {
				// 422 usually means "already exists" or "no commits between";
				// GitHub's own wording is worth passing through.
				return refuse("Opening the pull request failed: %s", pr.message())
			}

			number, _ := pr.Body["number"].(float64)
			return ok("Opened pull request #%d: %s", int(number), str(pr.Body["html_url"]))
		},
	}
}

func describe(err error, response githubResponse) string {
	if err != nil {
		return err.Error()
	}
	return response.message()
}

func orQuestion(value string) string {
	if value == "" {
		return "?"
	}
	return value
}
