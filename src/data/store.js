// Conversation and settings, kept in memory and written through to
// localStorage and Cloudflare KV so a reload picks up where the last one left off.

const KEY = "llm-playground:v1";

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

let saveTimer = null;

export function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "{}");
    if (saved.settings) Object.assign(state.settings, saved.settings);
    if (Array.isArray(saved.messages)) state.messages = saved.messages;
  } catch {
    // Corrupt or unavailable storage just means starting fresh.
  }

  // Fetch server-side settings from KV asynchronously
  fetchServerSettings();

  return state;
}

async function fetchServerSettings() {
  try {
    const res = await fetch("/api/settings");
    if (!res.ok) return;
    const data = await res.json();
    if (data && data.settings && typeof data.settings === "object") {
      Object.assign(state.settings, data.settings);
      saveLocal();
      // Dispatch custom event so app.js can re-sync controls
      window.dispatchEvent(new CustomEvent("settings-synced", { detail: state.settings }));
    }
  } catch {
    // Offline or unreachable — localStorage fallback remains active.
  }
}

function saveLocal() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Private browsing or a full quota shouldn't break the app.
  }
}

function syncServer() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await fetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(state.settings),
      });
    } catch {
      // Failed sync is non-fatal; will try again on next change or stay local.
    }
  }, 600);
}

export function settings() {
  return state.settings;
}

export function updateSettings(patch) {
  Object.assign(state.settings, patch);
  saveLocal();
  syncServer();
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
  saveLocal();
  return message;
}

export function removeMessage(message) {
  const index = state.messages.indexOf(message);
  if (index !== -1) state.messages.splice(index, 1);
  saveLocal();
}

export function commit() {
  saveLocal();
}

export function clearMessages() {
  state.messages = [];
  saveLocal();
}
