// Conversation and settings, kept in memory and written through to
// localStorage and Cloudflare KV via /api/settings so settings follow the user
// across devices and browsers.

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

let syncTimer = null;

export function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "{}");
    if (saved.settings) Object.assign(state.settings, saved.settings);
    if (Array.isArray(saved.messages)) state.messages = saved.messages;
  } catch {
    // Corrupt or unavailable storage just means starting fresh.
  }

  // Fetch server-side settings from KV via Worker API and merge/override
  fetchSettingsFromServer();

  return state;
}

async function fetchSettingsFromServer() {
  try {
    const res = await fetch("/api/settings");
    if (!res.ok) return;
    const data = await res.json();
    if (data && data.settings && typeof data.settings === "object") {
      Object.assign(state.settings, data.settings);
      save();
      // Dispatch an event so UI controllers know settings were updated from server
      window.dispatchEvent(new CustomEvent("settings-synced", { detail: state.settings }));
    }
  } catch {
    // Offline or local dev without KV configured
  }
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify({ settings: state.settings, messages: state.messages }));
  } catch {
    // Private browsing or a full quota shouldn't break the app.
  }

  // Debounce sync to server
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    fetch("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(state.settings),
    }).catch(() => {});
  }, 500);
}

export function settings() {
  return state.settings;
}

export function updateSettings(patch) {
  Object.assign(state.settings, patch);
  save();
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
