import { authenticate } from "./worker/access.js";
import { runAgent } from "./worker/agent.js";
import { PROVIDERS, describeProviders, modelCaps } from "./worker/providers.js";
import { createEventStream, sseHeaders } from "./worker/stream.js";
import { TOOL_DEFS } from "./worker/tools.js";

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

async function handleChat(request, env) {
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  const parsed = validateChatRequest(body);
  if (typeof parsed === "string") return jsonResponse({ error: parsed }, 400);

  const key = env[parsed.provider.keyVar];
  if (!key) {
    return jsonResponse(
      {
        error: `${parsed.provider.label} has no API key configured.`,
        details: `Set it with: wrangler secret put ${parsed.provider.keyVar}`,
      },
      400
    );
  }

  const stream = createEventStream();

  // Not awaited: the response returns as soon as headers are ready, and the
  // loop keeps writing to the stream until the conversation settles. Anything
  // that goes wrong after this point is reported as an event rather than a
  // status code, because the response has already begun.
  (async () => {
    try {
      await runAgent(
        {
          ...parsed,
          key,
          caps: modelCaps(parsed.provider, parsed.model),
          signal: request.signal,
          toolContext: { selfHost: new URL(request.url).hostname },
        },
        stream.emit
      );
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
          tools: TOOL_DEFS.map((tool) => ({ name: tool.name, description: tool.description })),
        });
      }

      if (url.pathname === "/api/chat") {
        try {
          return await handleChat(request, env);
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
