import { authenticate } from "./worker/access.js";
import { runAgent, runOnce } from "./worker/agent.js";
import { PROVIDERS, describeProviders, modelCaps } from "./worker/providers.js";
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
async function startTurn({ body, env, identity, url, emit, approve, signal }) {
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
        return handleSocket(request, ({ body, emit, approve, signal }) =>
          startTurn({ body, env, identity, url, emit, approve, signal }).then((problem) => {
            if (problem) emit({ type: "error", message: problem });
          })
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
