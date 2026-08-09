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
// Which model is running this turn, for tools that attribute their work. The
// label is the catalog's, falling back to the raw id so a "Custom…" model is
// still named rather than appearing as an anonymous commit.
function describeAgent(provider, model) {
  const known = provider.models.find((entry) => entry.id === model);
  return { label: known?.label ?? model, provider: provider.label, model };
}

function buildToolContext(env, url, owner, agent = null) {
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
    // Null when the caller is an MCP client: the model driving it is on the
    // other side of the protocol and never identifies itself to us.
    agent,
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
      toolContext: buildToolContext(
        env,
        url,
        identity.email,
        describeAgent(parsed.provider, parsed.model)
      ),
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

  (async () => {
    try {
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

// ---------- Settings API (KV Persistence) ----------

async function handleSettings(request, env, identity) {
  if (!env.MEMORY) {
    return jsonResponse({ error: "KV memory namespace not configured" }, 500);
  }

  const kvKey = `settings:${identity.email}`;

  if (request.method === "GET") {
    try {
      const val = await env.MEMORY.get(kvKey);
      const settings = val ? JSON.parse(val) : null;
      return jsonResponse({ settings });
    } catch (err) {
      return jsonResponse({ error: `Failed to load settings: ${err}` }, 500);
    }
  }

  if (request.method === "PUT") {
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "Invalid JSON" }, 400);
    }

    if (typeof body !== "object" || body === null) {
      return jsonResponse({ error: "Expected JSON object" }, 400);
    }

    try {
      await env.MEMORY.put(kvKey, JSON.stringify(body));
      return jsonResponse({ ok: true });
    } catch (err) {
      return jsonResponse({ error: `Failed to save settings: ${err}` }, 500);
    }
  }

  return jsonResponse({ error: "Method not allowed" }, 405);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const origin = env.PUBLIC_ORIGIN || url.origin;

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
    if (url.pathname.startsWith("/.well-known/oauth")) {
      return jsonResponse({ error: "not_found" }, 404);
    }
    if (url.pathname === "/oauth/register") return oauth.register(request, env);
    if (url.pathname === "/oauth/token") return oauth.token(request, env);
    if (url.pathname === "/oauth/revoke") return oauth.revoke(request, env);

    if (url.pathname === "/oauth/authorize") {
      const identity = await authenticate(request, env);
      if (identity.error) return jsonResponse({ error: identity.error }, identity.status);
      return oauth.authorize(request, env, identity.email, origin);
    }

    if (url.pathname === "/connections") {
      const identity = await authenticate(request, env);
      if (identity.error) return jsonResponse({ error: identity.error }, identity.status);
      return oauth.connections(request, env, identity.email);
    }

    if (url.pathname === "/api/mcp") {
      const grant = await oauth.verifyBearer(request, env, origin);
      if (!grant) return oauth.unauthorized(origin);
      return handleMcp(request, buildToolContext(env, url, grant.identity), grant.scopes);
    }

    if (url.pathname.startsWith("/api/")) {
      const identity = await authenticate(request, env);
      if (identity.error) return jsonResponse({ error: identity.error }, identity.status);

      if (url.pathname === "/api/providers") {
        return jsonResponse({
          email: identity.email,
          providers: describeProviders(env),
          tools: availableTools(env),
        });
      }
      if (url.pathname === "/api/chat") return handleChat(request, env, identity);
      if (url.pathname === "/api/settings") return handleSettings(request, env, identity);

      if (isUpgrade(request)) {
        return handleSocket(request, env, identity, buildToolContext);
      }

      return jsonResponse({ error: "Not found" }, 404);
    }

    return env.ASSETS.fetch(request);
  },
};
