# Go port (Cloud Run)

The Worker rebuilt as a Go service. The shape survives — provider adapters
behind one interface, a tool registry gated by configuration and scopes, an
agent loop streaming normalized events — but the platform change is not
cosmetic, and three things could not be translated literally.

## What changed, and why

**KV is a REST client, not a binding.** On Workers, `env.MEMORY.get()` was a
method call costing well under a millisecond. Off Workers there is no binding:
`internal/kv` speaks Cloudflare's REST API, so every read is an HTTPS round
trip that can fail. That is why it takes a context and returns errors, and why
`ErrNotFound` is distinct — a failed request must never be mistaken for an
empty store, which would read as "this was revoked".

**HTML reduction is a tokenizer, not HTMLRewriter.** `x/net/html` streams the
same way, so a large page still never becomes a DOM.

**The SSRF guard got stronger, because it had to.** Workers egress went to the
public internet and the platform held that boundary; the Worker version
documented DNS rebinding as out of scope. Cloud Run sits in a VPC with a
metadata server at 169.254.169.254 that hands out service-account tokens, so
`guardedDialer` re-checks the *resolved IP* at connect time, not just the
hostname.

**Cloudflare Access is no longer in front of the process.** Cloud Run answers
on its own URL whether or not a request came via Cloudflare, so verifying the
Access JWT is the only thing gating a private route rather than a second
opinion. `internal/access` pins RS256 explicitly.

## Idioms the port adopted

- Per-response `Decoder` instead of a mutable state bag passed back into every
  parse call: the state has one owner and two turns cannot share it.
- Events on a channel instead of an `emit` callback threaded through layers.
  Cancellation arrives through the context, so a loop cannot outlive its request.
- Interfaces declared by the consumer (`tools.KVStore`), so the package depends
  on a behaviour rather than on Cloudflare.
- Absence as `(value, found, err)` rather than a sentinel shared across packages.

## Layout

```
cmd/server/        main: config, routing, SSE
internal/kv/       Cloudflare KV over REST
internal/access/   Access JWT verification
internal/providers/ one file per vendor + the shared interface
internal/tools/    registry, sandboxing, and the tools
internal/agent/    the loop
internal/mcp/      JSON-RPC over POST
```

## Running

```bash
go test ./internal/...
LOCAL_DEV=1 GEMINI_API_KEY=... go run ./cmd/server   # :8080
docker build -t llm-playground .
```

Configuration is environment only: `PORT`, `PUBLIC_ORIGIN`, `STATIC_DIR`,
`CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, `LOCAL_DEV`, the provider keys, and
`CF_ACCOUNT_ID` / `CF_KV_NAMESPACE_ID` / `CF_KV_API_TOKEN` for memory.

## Not ported yet

- **OAuth** (`worker/oauth.js`, 827 lines): the authorization server, consent,
  grants, revocation, refresh chains. `/api/mcp` is currently gated by Access
  instead, which means no scoped delegation.
- **WebSocket transport**, and with it the mid-turn approval prompt. Cloud Run
  supports WebSockets, so this is a port rather than a redesign.
- The `/connections` page, which depends on grants.
