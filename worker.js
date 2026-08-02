import { authenticate } from "./worker/access.js";
import { runAgent, runOnce } from "./worker/agent.js";
import { PROVIDERS, describeProviders, modelCaps } from "./worker/providers.js";
import { handleMcp } from "./worker/mcp.js";
import * as oauth from "./worker/oauth.js";
import { handleSocket, isUpgrade } from "./worker/socket.js";
import { createEventStream, sseHeaders } from "./worker/stream.js";
import { CREDENTIALS, availableTools } from "./worker/tools.js";

// The browser never holds a provider API key. It posts a normalized chat
// request here; the Worker attaches the key from its secrets, runs the
// conversation (including any tool calls), and streams normalized events back.
// Cloudflare Access decides who is allowed to make that trade.

const MAX_MESSAGES = 200;
const MAX_CHARS = 200_000;
const MAX_OUTPUT_TOKENS = 128_000;
const DEFAULT_OUTPUT_TOKENS = 32_000;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Everything the tools are allowed to see. Built here rather than handing
// tools.js the whole env, so the only secrets that reach a tool are the ones
// it needs, and ask_model gets a narrow callback instead of the key ring.
function buildToolContext(env, url, owner) {
  const search = env.BRAVE_SEARCH_API_KEY
    ? { kind: "brave", key: env.BRAVE_SEARCH_API_KEY }
    : env.TAVILY_API_KEY
      ? { kind: "tavily", key: env.TAVILY_API_KEY }
      : null;

  const askable = Object.entries(PROVIDERS)
    .filter(([, provider]) => env[provider.keyVar])
    .map(([id]) => id);

  return {
    selfHost: url ? url.hostname : null,
    search,
    // Headers are built here so the raw keys never enter the tool context —
    // a tool sees "what to send to which hosts", not the key ring.
    credentials: CREDENTIALS.filter((c) => env[c.envVar]).map((c) => ({
      label: c.label,
      hosts: c.hosts,
      headers: c.header(env[c.envVar]),
    })),
    // The same token also backs the GitHub write tools.
    github: env.GITHUB_API_KEY
      ? { headers: { authorization: `Bearer ${env.GITHUB_API_KEY}` } }
      : null,
    // Notes are keyed by the Access identity, so the memory tools are only
    // available once we know who is asking.
    memory: env.MEMORY && owner ? { kv: env.MEMORY, owner } : null,
    askableProviders: askable,
    askModel: askable.length
      ? async ({ provider: id, model, prompt, maxTokens }) => {
          const provider = PROVIDERS[id];
          if (!provider) return { ok: false, content: `Unknown provider: ${id}` };
          const key = env[provider.keyVar];
          if (!key) return { ok: false, content: `${provider.label} has no API key configured.` };

          const chosen = (typeof model === "string" && model.trim()) || provider.models[0]?.id;
          if (!chosen) return { ok: false, content: `No model given for ${provider.label}.` };

          const answer = await runOnce({
            provider,
            key,
            model: chosen,
            caps: modelCaps(provider, chosen),
            prompt,
            maxTokens,
          });
          return { ...answer, content: `${provider.label} / ${chosen}:\n\n${answer.content}` };
        }
      : null,
  };
}

// Returns a normalized request, or a string describing what's wrong with it.
function validateChatRequest(body) {
  if (typeof body !== "object" || body === null) return "Expected a JSON object";

  const provider = PROVIDERS[body.provider];
  if (!provider) return `Unknown provider: ${body.provider}`;

  const model = typeof body.model === "string" ? body.model.trim() : "";
  if (!model || model.length > 200) return "A model id is required";

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return "At least one message is required";
  }
  if (body.messages.length > MAX_MESSAGES) return `At most ${MAX_MESSAGES} messages`;

  let chars = 0;
  for (const message of body.messages) {
    if (message?.role !== "user" && message?.role !== "assistant") {
      return "Each message needs a role of 'user' or 'assistant'";
    }
    if (typeof message.content !== "string" || message.content === "") {
      return "Each message needs non-empty string content";
    }
    chars += message.content.length;
  }
  if (chars > MAX_CHARS) return "Conversation is too long to send";

  const system = typeof body.system === "string" ? body.system.trim() : "";
  if (system.length > MAX_CHARS) return "System prompt is too long";

  let temperature = null;
  if (body.temperature != null) {
    temperature = Number(body.temperature);
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
      return "Temperature must be between 0 and 2";
    }
  }

  let maxTokens = DEFAULT_OUTPUT_TOKENS;
  if (body.maxTokens != null) {
    maxTokens = Math.floor(Number(body.maxTokens));
    if (!Number.isFinite(maxTokens) || maxTokens < 1 || maxTokens > MAX_OUTPUT_TOKENS) {
      return `maxTokens must be between 1 and ${MAX_OUTPUT_TOKENS}`;
    }
  }

  return {
    provider,
    model,
    system,
    messages: body.messages.map((m) => ({ role: m.role, content: m.content })),
    temperature,
    maxTokens,
    useTools: Boolean(body.tools),
  };
}

// Validate a chat body and run one turn, whatever the transport. Returns an
// error string if the request never got as far as starting.
async function startTurn({ body, env, identity, url, emit, approve, askContinue, signal }) {
  const parsed = validateChatRequest(body);
  if (typeof parsed === "string") return parsed;

  const key = env[parsed.provider.keyVar];
  if (!key) {
    return `${parsed.provider.label} has no API key configured. Set it with: wrangler secret put ${parsed.provider.keyVar}`;
  }

  await runAgent(
    {
      ...parsed,
      key,
      caps: modelCaps(parsed.provider, parsed.model),
      signal,
      approve,
      askContinue,
      toolContext: buildToolContext(env, url, identity.email),
    },
    emit
  );
  return null;
}

async function handleChat(request, env, identity) {
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  const stream = createEventStream();

  // Not awaited: the response returns as soon as headers are ready, and the
  // loop keeps writing to the stream until the conversation settles. Anything
  // that goes wrong after this point is reported as an event rather than a
  // status code, because the response has already begun.
  (async () => {
    try {
      // No approve hook here: this response only flows one way, so there is
      // no way for the browser to answer a question mid-turn.
      const problem = await startTurn({
        body,
        env,
        identity,
        url: new URL(request.url),
        emit: stream.emit,
        signal: request.signal,
      });
      if (problem) await stream.emit({ type: "error", message: problem });
    } catch (err) {
      if (err?.name !== "AbortError") {
        await stream.emit({ type: "error", message: `Request failed: ${err}` }).catch(() => {});
      }
    } finally {
      await stream.emit({ type: "done" }).catch(() => {});
      await stream.close().catch(() => {});
    }
  })();

  return new Response(stream.readable, { headers: sseHeaders() });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // The issuer identifier clients compare against. Configured rather than
    // derived, because request.url's host is whatever the last hop said it
    // was — `wrangler dev` reports the route hostname on GET and the real one
    // on POST, which would make discovery disagree with itself.
    const origin = env.PUBLIC_ORIGIN || url.origin;

    // Discovery and token exchange must be reachable without a session: a
    // client that doesn't have a token yet cannot be asked to present one.
    // These need an Access bypass policy on the deployed app — see the README.
    //
    // RFC 9728 locates a resource's metadata by inserting the well-known
    // segment *before* the resource's path, so a resource at /api/mcp is
    // described at /.well-known/oauth-protected-resource/api/mcp. Both that
    // and the bare form are served; a real client asks for the first.
    if (
      url.pathname === "/.well-known/oauth-protected-resource" ||
      url.pathname === `/.well-known/oauth-protected-resource${oauth.RESOURCE_PATH}`
    ) {
      return oauth.protectedResourceMetadata(origin);
    }
    if (
      url.pathname === "/.well-known/oauth-authorization-server" ||
      url.pathname === `/.well-known/oauth-authorization-server${oauth.RESOURCE_PATH}`
    ) {
      return oauth.authorizationServerMetadata(origin);
    }
    // Anything else under this prefix must 404 rather than fall through to the
    // SPA below. Answering a discovery request with the app shell returns HTML
    // and a 200, which a client reads as success and then cannot parse — the
    // failure mode that hides itself.
    if (url.pathname.startsWith("/.well-known/oauth")) {
      return jsonResponse({ error: "not_found" }, 404);
    }
    if (url.pathname === "/oauth/register") return oauth.register(request, env);
    if (url.pathname === "/oauth/token") return oauth.token(request, env);

    // Consent, by contrast, is exactly where identity is needed, so it stays
    // behind Access: the token is bound to whoever is signed in.
    if (url.pathname === "/oauth/authorize") {
      const identity = await authenticate(request, env);
      if (identity.error) return jsonResponse({ error: identity.error }, identity.status);
      return oauth.authorize(request, env, identity.email, origin);
    }

    // The MCP endpoint accepts either a delegated bearer token or an Access
    // session. A bearer token carries scopes; an Access session is the account
    // holder and carries none, meaning no restriction.
    if (url.pathname === "/api/mcp") {
      const bearer = request.headers.get("authorization");
      if (bearer) {
        const grant = await oauth.verifyBearer(request, env, origin);
        if (!grant) return oauth.unauthorized(origin, "Invalid or expired access token");
        return handleMcp(request, buildToolContext(env, url, grant.identity), grant.scopes);
      }
      const identity = await authenticate(request, env);
      // Steer a browser-less client toward OAuth rather than a login redirect.
      if (identity.error) return oauth.unauthorized(origin);
      return handleMcp(request, buildToolContext(env, url, identity.email));
    }

    if (url.pathname.startsWith("/api/")) {
      const identity = await authenticate(request, env);
      if (identity.error) return jsonResponse({ error: identity.error }, identity.status);

      if (url.pathname === "/api/providers") {
        return jsonResponse({
          email: identity.email,
          providers: describeProviders(env),
          tools: availableTools(buildToolContext(env, url, identity.email)).map((tool) => ({
            name: tool.name,
            description: tool.description,
          })),
        });
      }

      // Two-way transport, so tools that need confirmation can ask.
      if (url.pathname === "/api/socket") {
        if (!isUpgrade(request)) return jsonResponse({ error: "Expected a WebSocket upgrade" }, 426);
        return handleSocket(request, ({ body, emit, approve, askContinue, signal }) =>
          startTurn({ body, env, identity, url, emit, approve, askContinue, signal }).then(
            (problem) => {
              if (problem) emit({ type: "error", message: problem });
            }
          )
        );
      }

      if (url.pathname === "/api/chat") {
        try {
          return await handleChat(request, env, identity);
        } catch (err) {
          return jsonResponse({ error: "Chat request failed", details: String(err) }, 502);
        }
      }

      return jsonResponse({ error: "Not found" }, 404);
    }

    // Static files in public/ are matched before the Worker runs; anything
    // else is a client-side route, so serve the app shell.
    return env.ASSETS.fetch(new Request(new URL("/", url), request));
  },
};
