# LLM Playground

A personal chat playground for talking to several LLM APIs through one UI.
Provider APIs are reached through a Cloudflare Worker that holds the keys, so
no key is ever sent to the browser.

Deployed as a Cloudflare Worker at `llm.timgcavell.com`, gated by Cloudflare
Access.

## Layout

```
src/            JavaScript sources (bundled into public/app.js)
  lib/          Dependency-free helpers: SSE reading
  data/         Provider catalog fetch, and the conversation/settings store
  ui/           Rendering: one message, with streaming updates
  app.js        Entry point: DOM refs, controls, and the send loop
public/         Deployed assets: index.html (CSS inlined) + the built bundle
worker.js       Worker entry: routing, request validation, response streaming
worker/
  access.js     Cloudflare Access JWT verification
  providers.js  Provider catalog + per-vendor request/response adapters
  agent.js      The loop: stream a turn, run tools, feed results back
  tools.js      Tool definitions and their sandboxing
  stream.js     SSE framing, in both directions
```

Dependencies run one way: `lib/ <- data/ <- ui/ <- app.js`.

Sources are bundled into a single `public/app.js` so a page load makes one
JavaScript request. Behind Access an expired session can turn any subresource
request into a login redirect, and one bundle keeps that from partially loading
the app.

## Commands

```bash
npm run build   # bundle src/ -> public/app.js
npm run watch   # rebuild on change
npm run dev     # build, then run the Worker locally (wrangler dev)
npm run deploy  # build, then deploy to Cloudflare
```

`public/app.js` is generated and not checked in; every script that serves or
deploys builds it first.

## API keys

Keys live only in the Worker. The browser posts a conversation to `/api/chat`,
the Worker attaches the key for the chosen provider and calls the API, then
streams the reply back. `/api/providers` reports *whether* a key exists, never
its value.

In production each key is a Wrangler secret (encrypted, not in `wrangler.toml`,
not in git):

```bash
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put GEMINI_API_KEY
wrangler secret put OPENAI_API_KEY
```

Locally they come from `.dev.vars`, which is untracked — copy
`.dev.vars.example` and fill in whichever providers you want. Only providers
with a key are usable; the rest show as "(no key)" in the picker.

Because the Worker spends those keys on behalf of whoever reaches it, it fails
closed: with `CF_ACCESS_AUD` unset it serves a stub identity on `localhost`
only, and a deployed Worker with no AUD refuses every `/api/chat` request. Fill
`CF_ACCESS_AUD` in `wrangler.toml` from the Access app's Application Audience
tag before deploying.

## Providers

| Provider  | Key                 | Endpoint                                    |
| --------- | ------------------- | ------------------------------------------- |
| Anthropic | `ANTHROPIC_API_KEY` | `/v1/messages`, streaming                   |
| Google    | `GEMINI_API_KEY`    | `:streamGenerateContent?alt=sse`            |
| OpenAI    | `OPENAI_API_KEY`    | `/v1/chat/completions`, streaming           |

Each provider is one entry in `worker/providers.js` supplying three things: a
model list with capability flags, a `request()` that builds the upstream fetch,
and a `parse()` that turns one upstream SSE payload into normalized events:

```
{ type: "text",       text }
{ type: "thinking",   text }
{ type: "tool_call",  id, name, input, summary }
{ type: "tool_result", id, name, ok, content }
{ type: "meta",       stopReason, usage: { input, output }, round }
{ type: "error",      message }
```

Everything above that layer — the Worker's router, the whole front end — only
ever sees those four shapes. Adding a provider is a new entry in that file and
a new secret; no other file changes.

Capability flags exist because the vendors disagree about the basics. Current
Anthropic models and the OpenAI reasoning models reject `temperature` with a
400 rather than ignoring it, so models are marked with whether they accept one
and the control greys out to match. The same table marks which models stream
reasoning, which is shown in a collapsible block above the reply.

Model ids move faster than a checked-in list does, so the model picker has a
"Custom…" option that accepts any id. An unrecognized id still works — it just
inherits the provider's default capability flags.

## Tool calling

Tools are off by default; the settings panel turns them on.

| Tool | What it does | Needs |
| ---- | ------------ | ----- |
| `fetch_url` | Retrieves a public http(s) URL. HTML is reduced to readable text with `HTMLRewriter`; JSON comes back as-is. | — |
| `web_search` | Top results as title/URL/snippet. Pairs with `fetch_url`: search, pick, read. | `BRAVE_SEARCH_API_KEY` or `TAVILY_API_KEY` |
| `get_current_time` | The current date and time, optionally in an IANA zone. | — |
| `ask_model` | Puts a one-off question to a different model and returns its answer. | a second provider key |
| `save_memory` / `read_memory` / `list_memories` / `delete_memory` | Notes that persist across conversations, in Workers KV. | the `MEMORY` KV binding |
| `github_write_file` / `github_open_pr` | Commit one file to a branch; open a PR to the default branch. | `GITHUB_API_KEY` |

Availability follows configuration, the same way providers do: a tool whose
backing key is missing is never offered to the model, rather than being offered
and always failing. With no search key, `web_search` simply isn't in the list.

`ask_model` reuses the provider adapters for a single prompt with no history
and no tools of its own — which is also what stops two models calling each
other in a loop.

The memory tools are the first with side effects. Keys are namespaced by the
Cloudflare Access email (`mem:<email>:<key>`), so one person's notes are
unreachable from another's session even though they share a namespace — the
scheme the jobs app uses for tracked jobs. `:` is excluded from keys, so the
owner prefix cannot be forged from the key side.

Deletion is the sharp edge, because the confirmation gap above is still open:
there is nowhere for the browser to approve an action mid-stream. So
`delete_memory` takes one exact key with no prefix or wildcard form — the model
cannot clear the store in a single call — and an overwrite reports what it
replaced rather than succeeding silently.

With tools enabled a send becomes a loop in `worker/agent.js`: stream a turn,
run whatever tools the model asked for, hand the results back, stream the next
turn. The budget is five rounds; on the socket transport exhausting it asks
whether to continue and each yes grants five more, while on SSE — which cannot
ask — the turn just stops there. The browser sees one continuous event stream either
way, so a tool call is a rendering detail rather than a protocol change. Tool
calls appear in the transcript as collapsed rows that expand to the exact text
the model was given.

Tools are declared once in `worker/tools.js` as plain JSON Schema; each adapter
translates that into its own dialect (`input_schema`, `functionDeclarations`,
`type: "function"`). The awkward part is the return leg: the assistant turn
containing the tool call has to be sent back *verbatim*, and reasoning blocks
carry signatures the provider validates. So each adapter accumulates the raw
native content as it streams rather than reconstructing it afterwards, and
exposes `assistantTurn`/`resultTurn` to replay it.

Two consequences worth knowing:

- **The loop resolves inside one request.** What the browser stores is one user
  message and one assistant reply, so history stays vendor-neutral and you can
  switch providers mid-conversation. The cost is that a later turn sees the
  model's summary of what it fetched, not the raw tool transcript.
- **Tool rows are hoisted above the reply text.** Calls and text are kept in
  order within themselves, but narration interleaved between calls collapses
  into one block.

### What the tool will not fetch

The model chooses the URL, so `fetch_url` is a request forgery surface. It
refuses non-http(s) schemes, this Worker's own origin, and private, loopback,
and link-local addresses — including cloud metadata at `169.254.169.254`. It
blocks address *literals*; a public hostname that resolves to a private address
would still pass, which is the platform's boundary to hold rather than this
Worker's, since Workers egress goes out to the public internet. Responses are
capped at 512 KB read, 12,000 characters given to the model, and a 15s timeout.

Fetched pages are untrusted input going straight into the context window, so
the tool result is prefixed with a note saying so. Treat that as mitigation,
not a guarantee: a page that tells the model to fetch something else may well
get it to try.

### Authenticated fetches

`fetch_url` can attach a credential for specific hosts — currently a GitHub
token (`GITHUB_API_KEY`) for `api.github.com` and `raw.githubusercontent.com`,
which lets the model read private repos and skip the unauthenticated rate
limit. The `CREDENTIALS` table in `worker/tools.js` maps each secret to the
hosts it may be sent to; adding an API is one entry plus one secret.

The model picks the URLs, so scoping is what keeps the token from being handed
to an arbitrary host. Redirects are followed manually with the credential
decision remade per hop — `redirect: "follow"` would carry the header wherever
the chain led, so an authenticated host answering with a redirect elsewhere
would exfiltrate the token. Authenticated results say `Authenticated: GitHub`
in the transcript, and the tool description names the authenticated hosts so
the model knows a private repo is reachable.

### Writing to GitHub

The same token backs two write tools. `github_write_file` commits one file per
call to a branch, creating the branch from the default branch when it doesn't
exist; `github_open_pr` opens a pull request. Reads go through `fetch_url`.

The guardrail is that **the default branch is refused outright** — there is no
way to ask for a direct commit to it. The model proposes on a branch, and the
human reviews and merges in GitHub, where the diff view is. Everything these
tools can do is undoable from there: delete the branch, close the PR. Both are
approval-gated on the socket transport, and the token's own scopes (a
fine-grained PAT with Contents and Pull requests read/write, ideally limited to
chosen repositories) bound the blast radius regardless of what the tools allow.

## Transports

Two ways to run a turn, chosen by a checkbox in the settings panel. Both carry
the same normalized events, because the agent loop writes everything through a
single `emit` callback and never learns what it points at.

| | `/api/chat` (default) | `/api/socket` (spike) |
| --- | --- | --- |
| Shape | POST, then a one-way SSE response | WebSocket |
| Can ask mid-turn | no | yes |
| Destructive tools | run directly | prompt for approval |

The socket exists for one reason: a one-way response has nowhere for the
browser to answer a question, so the Worker cannot pause before a destructive
tool. Over the socket it can — `delete_memory` renders Approve/Deny in the
transcript and the turn blocks until you answer. A denial comes back to the
model as a tool result saying you declined, so it can respond sensibly instead
of assuming success. A closed socket or an unanswered prompt resolves as a
refusal: failing closed is the right default for something only being confirmed
because it's destructive.

Two things about this are unfinished:

- **It is a plain Worker, not a Durable Object.** Cloudflare's guidance is that
  server-side WebSockets belong in a DO, since a Worker is stateless with no
  guaranteed lifetime, which makes a long-lived socket best-effort. For one
  browser holding one socket for one turn this appears to work, and the point
  of the spike was to find out whether the rest of the design held up before
  taking on that machinery. It does; the DO question is still open.
- **Access has not been tested in front of it.** Locally there is no Access in
  the path, so the handshake proves nothing about production. The upgrade
  should pass — it is an HTTP request and the browser sends the
  `CF_Authorization` cookie on a same-origin upgrade, which `authenticate()`
  already reads — but that is reasoning, not evidence. Check it before relying
  on the socket path from the deployed app.

## State

The conversation and the settings live in `localStorage`; the Worker is
stateless and the browser resends the full conversation each turn. Nothing is
stored server-side yet — cross-device history would mean a KV namespace keyed
by the Access email, the way the jobs app stores its tracked jobs.
