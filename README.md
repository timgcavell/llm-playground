# LLM Playground

A personal chat playground for talking to several LLM APIs through one UI.
Deployed as a Cloudflare Worker at `llm.timgcavell.com`, gated by Cloudflare
Access. The Worker holds the keys, so none ever reaches the browser.

## Layout

```
src/            Client sources, bundled into public/app.js
  lib/          SSE reading, transports
  data/         Provider catalog, conversation/settings store
  ui/           Message rendering
  app.js        DOM refs, controls, send loop
public/         index.html (CSS inlined) + the built bundle
worker.js       Routing, request validation, response streaming
worker/
  access.js     Access JWT verification
  oauth.js      OAuth 2.1 server for the MCP endpoint
  providers.js  Model catalog + per-vendor adapters
  agent.js      The loop: stream a turn, run tools, feed results back
  tools.js      Tool definitions and sandboxing
  mcp.js        JSON-RPC over POST
  socket.js     WebSocket transport
  stream.js     SSE framing
evals/          Fixed task set run through /api/chat
```

Client dependencies run one way: `lib/ <- data/ <- ui/ <- app.js`. Everything
bundles into one `public/app.js`, because behind Access an expired session turns
any subresource request into a login redirect, and one bundle keeps that from
partially loading the app.

## Commands

```bash
npm run dev     # build, then wrangler dev
npm run build   # bundle src/ -> public/app.js
npm run watch   # rebuild on change
npm run deploy  # build, then deploy
npm run eval    # run the eval set (needs wrangler dev)
```

`public/app.js` is generated and untracked; everything that serves or deploys
builds it first.

## Configuration

Keys are Wrangler secrets, never `wrangler.toml`:

```bash
wrangler secret put ANTHROPIC_API_KEY   # also GEMINI_API_KEY, OPENAI_API_KEY
wrangler secret put BRAVE_SEARCH_API_KEY  # or TAVILY_API_KEY, for web_search
wrangler secret put GITHUB_API_KEY        # for the GitHub tools
```

Locally they come from `.dev.vars` — copy `.dev.vars.example`. Only providers
with a key are offered; the rest show as "(no key)".

Two KV namespaces are bound in `wrangler.toml`: `MEMORY` for notes and synced
settings, `OAUTH` for clients, codes, and tokens. Kept separate so credentials
and user notes never share a keyspace.

**`CF_ACCESS_AUD` must be set before deploying.** The Worker spends your keys on
behalf of whoever reaches it, so it fails closed: with no audience configured it
serves a stub identity on `localhost` only, and a deployed Worker refuses every
`/api/chat` request. Fill it from the Access app's Application Audience tag.

## Providers

| Provider  | Key                 | Endpoint                         |
| --------- | ------------------- | -------------------------------- |
| Anthropic | `ANTHROPIC_API_KEY` | `/v1/messages`                   |
| Google    | `GEMINI_API_KEY`    | `:streamGenerateContent?alt=sse` |
| OpenAI    | `OPENAI_API_KEY`    | `/v1/chat/completions`           |

Each is one entry in `worker/providers.js` supplying a model list with
capability flags, a `request()` that builds the upstream fetch, and a `parse()`
that normalizes one upstream SSE payload into these events:

```
{ type: "text" | "thinking",  text }
{ type: "tool_call",          id, name, input, summary }
{ type: "tool_result",        id, name, ok, content }
{ type: "meta",               stopReason, usage, round }
{ type: "error",              message }
```

Nothing above that layer sees vendor shapes, so adding a provider is one entry
plus one secret. Capability flags exist because vendors disagree about basics —
current Anthropic models and OpenAI reasoning models reject `temperature` with a
400 rather than ignoring it, so the control greys out to match. The model picker
has a "Custom…" option for ids newer than the checked-in list.

## Tools

Off by default; the settings panel turns them on.

| Tool | What it does | Needs |
| ---- | ------------ | ----- |
| `fetch_url` | Retrieves a public http(s) URL. HTML reduced to text via `HTMLRewriter`. | — |
| `web_search` | Title/URL/snippet results. Pairs with `fetch_url`. | a search key |
| `get_current_time` | Current time, optionally in an IANA zone. | — |
| `ask_model` | Puts a one-off question to a different model. | a second provider key |
| `save_memory` / `read_memory` / `list_memories` / `delete_memory` | Notes that persist across conversations. | `MEMORY` |
| `github_write_file` / `github_open_pr` | Commit one file to a branch; open a PR. | `GITHUB_API_KEY` |

A tool whose backing key is missing is never offered, rather than offered and
always failing.

The constraints that matter, since the model chooses the inputs:

- **`fetch_url` is a request-forgery surface.** It refuses non-http(s) schemes,
  this Worker's own origin, and private, loopback, and link-local addresses
  including `169.254.169.254`. It blocks address *literals*; a hostname
  resolving to a private address is the platform's boundary, not ours. Capped at
  512 KB read, 12,000 characters to the model, 15s.
- **Fetched pages are untrusted input** going into the context window. The
  result says so. That is mitigation, not a guarantee.
- **Credentials are scoped per host.** `CREDENTIALS` in `worker/tools.js` maps
  each secret to the hosts it may go to. Redirects are followed manually with
  the decision remade per hop, so an authenticated host redirecting elsewhere
  cannot exfiltrate the token.
- **The GitHub default branch is refused outright.** The model proposes on a
  branch; you review and merge in GitHub. Everything these tools do is undoable
  there.
- **Commits are attributed to the model, not to the token owner.** Git's own
  split does the work: the *author* is the model that asked for the commit, the
  *committer* is `llm-playground`, both at a non-routable address that matches
  no GitHub account. Two things this cannot change — the token still identifies
  you as the pusher, and a PR is always opened by the account the token belongs
  to, since the API offers no way to say otherwise. The PR body carries a
  footer naming the real author for that reason. `COMMIT_EMAIL` in
  `worker/tools.js` is the address.
- **Over MCP the author is the client's registered name**, suffixed
  `(MCP client)` — the model driving an external client never identifies itself,
  so its name is the best available answer. The suffix is not decoration: that
  name is self-asserted at registration and proves nothing, so it must never be
  able to read as a person committing directly. A client calling itself
  "Tim Cavell" commits as `Tim Cavell (MCP client)`.
- **Memory keys are namespaced by Access email** (`mem:<email>:<key>`), and `:`
  is excluded from keys so the owner prefix cannot be forged. `delete_memory`
  takes one exact key — no prefix or wildcard form.

## Transports

Two ways to run a turn, chosen in settings, both carrying the same events.

| | `/api/chat` | `/api/socket` |
| --- | --- | --- |
| Shape | POST + one-way SSE | WebSocket |
| Can ask mid-turn | no | yes |
| Destructive tools | run directly | prompt for approval |

The socket exists because a one-way response has nowhere for the browser to
answer, so the Worker cannot pause before a destructive tool. Over the socket it
can, and a denial returns to the model as a tool result saying you declined. A
closed socket or unanswered prompt resolves as a refusal.

It is a plain Worker, not a Durable Object — Cloudflare's guidance is that
server-side WebSockets belong in a DO, so a long-lived socket here is
best-effort. Fine for one browser holding one socket for one turn.

## MCP server

The tool registry is also an MCP server at `/api/mcp` — stateless Streamable
HTTP (JSON-RPC 2.0 over POST): `initialize`, `tools/list`, `tools/call`, `ping`.

```bash
claude mcp add --transport http playground https://llm.timgcavell.com/api/mcp
```

**MCP is OAuth-only, and Access must bypass it.** Access answers a bearer token
with a login redirect, which no MCP client can read, so it cannot gate this
path — `worker/oauth.js` is the sole authority instead, validating opaque tokens
against KV and enforcing per-tool scopes.

| Scope | Tools |
| --- | --- |
| `tools:read` | `fetch_url`, `web_search`, `get_current_time`, `ask_model` |
| `memory:read` | `read_memory`, `list_memories` |
| `memory:write` | `save_memory`, `delete_memory` |
| `github:write` | `github_write_file`, `github_open_pr` |

Out-of-scope tools are absent from `tools/list` and unknown to `tools/call`. An
Access session carries no scopes and sees everything: it is the account holder,
not a delegate. `/connections` lists and revokes grants.

### Deploying this needs an Access bypass

A client with no token cannot be asked to present one, so `/.well-known/*`,
`/oauth/register`, `/oauth/token`, `/oauth/revoke`, and `/api/mcp` must be
reachable without a session, while `/oauth/authorize` stays gated — that is
where identity comes from. Add an Access policy with action **Bypass** scoped to
those paths. **Scope it by prefix, not exact path**:
`/.well-known/oauth-protected-resource/api/mcp` must be reachable too, and a
rule matching only the bare path makes discovery fail at the first request.

### Design notes

- PKCE S256 required, no client secrets — a secret in a desktop config file
  protects nothing.
- The consent screen names the destination host, not `client_name`. Registration
  is open per spec, so a hostile client can call itself "Claude"; the redirect
  host is the part it cannot fake.
- Tokens are opaque and stored only as SHA-256 digests.
- Authorization codes burn on any exchange attempt; refresh tokens rotate only
  on success, so one malformed request cannot destroy a working grant.
- Refresh reuse revokes the whole grant. Rotated tokens are kept two days, not
  thirty — long enough to detect replay, short enough not to accumulate.
- Grants are the durable record; tokens point at them. Revoking deletes the
  grant, stopping every token that referenced it on the next request.
- `resource` (RFC 8707) is validated both ends, closing the confused-deputy
  problem.
- `PUBLIC_ORIGIN` is configured, not derived — clients compare the issuer
  byte-for-byte, and `request.url`'s host is whatever the last hop claimed.

## Evals

`npm run eval` runs `evals/cases.mjs` through `/api/chat`, the same surface the
UI uses, so a pass means the whole stack worked. Needs `wrangler dev` running.
Checks are deterministic where possible (`contains`, `tool_called`,
`no_tools_called`, `tools_ok`) with an LLM judge only where a string match would
be brittle.

```bash
npm run eval
node evals/run.mjs run --models a,b --filter fetch
node evals/run.mjs compare results/old.json results/new.json
```

Results land in `evals/results/` (untracked). Both commands exit non-zero on
failure, so they can gate CI.

## State

The conversation lives only in `localStorage`; the Worker is stateless and the
browser resends the full conversation each turn. Settings also cache there for
a fast reload, but sync through `/api/settings` to `MEMORY`, keyed by Access
email, so they follow you to a different browser or device. Nothing else is
stored server-side except memory notes.
