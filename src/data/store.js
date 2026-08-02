// Conversation and settings, kept in memory and written through to
// localStorage so a reload picks up where the last one left off. Nothing here
// touches the network: the Worker is stateless, and the browser resends the
// whole conversation on every turn.

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
