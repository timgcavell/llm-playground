// Conversation and settings, kept in memory and written through to
// localStorage so a reload picks up where the last one left off.
//
// Settings also sync to the Worker's KV store, keyed by the signed-in Access
// identity, so they follow you to a different browser or device. The
// conversation itself stays local only — it's not namespaced by size the way
// a KV value would need to be, and there's no reason a phone and a laptop
// should share one transcript.

const KEY = "llm-playground:v1";
const REMOTE_SYNC_DEBOUNCE_MS = 800;

const DEFAULT_SETTINGS = {
  provider: null,
  model: null,
  system: "",
  temperature: 1,
  maxTokens: 32000,
  // Off by default: enabling it lets the model fetch arbitrary public URLs.
  tools: false,
  // Spike: the two-way transport, which can prompt before a destructive tool.
  socket: false,
};

const state = {
  settings: { ...DEFAULT_SETTINGS },
  messages: [],
};

export function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "{}");
    if (saved.settings) Object.assign(state.settings, saved.settings);
    if (Array.isArray(saved.messages)) state.messages = saved.messages;
  } catch {
    // Corrupt or unavailable storage just means starting fresh.
  }
  return state;
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Private browsing or a full quota shouldn't break the app.
  }
}

// Pulls settings saved from another device and merges them in. Best-effort:
// offline, a fresh install with nothing saved yet, or Access not configured
// (local dev) should all just fall through to whatever localStorage had.
export async function syncFromRemote() {
  try {
    const res = await fetch("/api/settings");
    if (!res.ok) return;
    const { settings: remote } = await res.json();
    if (remote) {
      Object.assign(state.settings, remote);
      save();
    }
  } catch {
    // Network error: local settings still work.
  }
}

let syncTimer = null;

// Debounced so a dragged slider or a typed system prompt doesn't fire a PUT
// per keystroke; the last value within the window wins.
function scheduleRemoteSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    syncTimer = null;
    try {
      await fetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(state.settings),
      });
    } catch {
      // Best-effort: localStorage already has the change, and the next edit
      // retries.
    }
  }, REMOTE_SYNC_DEBOUNCE_MS);
}

export function settings() {
  return state.settings;
}

export function updateSettings(patch) {
  Object.assign(state.settings, patch);
  save();
  scheduleRemoteSync();
}

export function messages() {
  return state.messages;
}

// Only role and content go upstream — thinking summaries, tool transcripts and
// usage are local display state. The tool loop is resolved inside a single
// request, so history stays vendor-neutral and the provider can be switched
// mid-conversation.
export function turnsForRequest() {
  return state.messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .filter((m) => m.content.trim() !== "")
    .map((m) => ({ role: m.role, content: m.content }));
}

export function addMessage(message) {
  state.messages.push(message);
  save();
  return message;
}

export function removeMessage(message) {
  const index = state.messages.indexOf(message);
  if (index !== -1) state.messages.splice(index, 1);
  save();
}

export function commit() {
  save();
}

export function clearMessages() {
  state.messages = [];
  save();
}
