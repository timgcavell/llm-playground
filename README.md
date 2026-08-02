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
worker.js       Worker entry: routing, request validation, the chat proxy
worker/
  access.js     Cloudflare Access JWT verification
  providers.js  Provider catalog + per-vendor request/response adapters
  stream.js     Upstream SSE -> normalized SSE
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
{ type: "text",     text }
{ type: "thinking", text }
{ type: "meta",     stopReason, usage: { input, output } }
{ type: "error",    message }
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

## State

The conversation and the settings live in `localStorage`; the Worker is
stateless and the browser resends the full conversation each turn. Nothing is
stored server-side yet — cross-device history would mean a KV namespace keyed
by the Access email, the way the jobs app stores its tracked jobs.
