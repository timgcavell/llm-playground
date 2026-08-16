// Per-user chat settings (provider, model, system prompt, ...), persisted so
// they follow you across devices instead of living in one browser's
// localStorage.
//
// Reuses the MEMORY namespace rather than adding a binding for one small JSON
// blob per user. "settings:" is a distinct prefix from the memory tools'
// "mem:", so list_memories's prefix scan never sees it and a settings write
// can never collide with a note key.

const MAX_MODEL_CHARS = 200;
const MAX_SYSTEM_CHARS = 200_000; // matches the chat request's own limit
const MAX_OUTPUT_TOKENS = 128_000;

function storageKey(owner) {
  return `settings:${owner}`;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Keeps only fields store.js actually keeps client-side, each bounds-checked
// the same way validateChatRequest checks a chat body. Unknown or malformed
// fields are dropped rather than rejected, so an older client and a newer
// server can still talk to each other.
function sanitize(body) {
  if (typeof body !== "object" || body === null) return {};
  const out = {};

  if (typeof body.provider === "string" && body.provider.length <= 100) {
    out.provider = body.provider;
  }
  if (typeof body.model === "string" && body.model.length <= MAX_MODEL_CHARS) {
    out.model = body.model;
  }
  if (typeof body.system === "string" && body.system.length <= MAX_SYSTEM_CHARS) {
    out.system = body.system;
  }
  if (body.temperature != null) {
    const temperature = Number(body.temperature);
    if (Number.isFinite(temperature) && temperature >= 0 && temperature <= 2) {
      out.temperature = temperature;
    }
  }
  if (body.maxTokens != null) {
    const maxTokens = Math.floor(Number(body.maxTokens));
    if (Number.isFinite(maxTokens) && maxTokens >= 1 && maxTokens <= MAX_OUTPUT_TOKENS) {
      out.maxTokens = maxTokens;
    }
  }
  if (typeof body.tools === "boolean") out.tools = body.tools;
  if (typeof body.socket === "boolean") out.socket = body.socket;

  return out;
}

export async function getSettings(env, owner) {
  if (!env.MEMORY) return jsonResponse({ settings: null });
  const raw = await env.MEMORY.get(storageKey(owner));
  return jsonResponse({ settings: raw ? JSON.parse(raw) : null });
}

export async function putSettings(request, env, owner) {
  if (!env.MEMORY) return jsonResponse({ error: "Settings storage is not configured" }, 503);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  const settings = sanitize(body);
  await env.MEMORY.put(storageKey(owner), JSON.stringify(settings));
  return jsonResponse({ settings });
}
