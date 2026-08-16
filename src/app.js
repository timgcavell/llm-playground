// Entry point: DOM wiring, the provider/model controls, and the send loop.
//
// The browser holds the conversation; the Worker holds the API keys. Every
// turn posts the whole conversation to /api/chat and reads back a normalized
// event stream, so this file never knows which vendor answered.

import { openHttp, openSocket } from "./lib/transport.js";
import {
  capsFor,
  defaultProvider,
  getProvider,
  loadCatalog,
  priceFor,
  providers,
  tools,
} from "./data/catalog.js";
import {
  addMessage,
  clearMessages,
  commit,
  load,
  messages,
  removeMessage,
  settings,
  syncFromRemote,
  turnsForRequest,
  updateSettings,
} from "./data/store.js";
import { describeMeta, renderMessage } from "./ui/message.js";

const CUSTOM_MODEL = "__custom__";

const el = {
  provider: document.getElementById("provider"),
  model: document.getElementById("model"),
  customModel: document.getElementById("custom-model"),
  toggleSettings: document.getElementById("toggle-settings"),
  newChat: document.getElementById("new-chat"),
  settings: document.getElementById("settings"),
  system: document.getElementById("system"),
  temperature: document.getElementById("temperature"),
  temperatureValue: document.getElementById("temperature-value"),
  temperatureNote: document.getElementById("temperature-note"),
  maxTokens: document.getElementById("max-tokens"),
  toolsEnabled: document.getElementById("tools-enabled"),
  toolsNote: document.getElementById("tools-note"),
  useSocket: document.getElementById("use-socket"),
  thread: document.getElementById("thread"),
  scroller: document.querySelector("main"),
  composer: document.getElementById("composer"),
  prompt: document.getElementById("prompt"),
  send: document.getElementById("send"),
  stop: document.getElementById("stop"),
  status: document.getElementById("status"),
};

let inFlight = null; // AbortController while a response is streaming

// ---------- Status line ----------

function setStatus(text, isError = false) {
  el.status.textContent = text;
  el.status.classList.toggle("error", isError);
}

// ---------- Transcript ----------

function nearBottom() {
  const { scrollTop, scrollHeight, clientHeight } = el.scroller;
  return scrollHeight - scrollTop - clientHeight < 120;
}

function scrollToBottom() {
  el.scroller.scrollTop = el.scroller.scrollHeight;
}

function appendMessage(message) {
  const handle = renderMessage(message);
  el.thread.append(handle.el);
  return handle;
}

function renderThread() {
  el.thread.replaceChildren();
  if (messages().length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent =
      "Pick a provider and model, then send a message. The conversation stays in this browser; API keys stay in the Worker.";
    el.thread.append(empty);
    return;
  }
  for (const message of messages()) appendMessage(message);
  scrollToBottom();
}

// ---------- Controls ----------

function currentModel() {
  return el.model.value === CUSTOM_MODEL ? el.customModel.value.trim() : el.model.value;
}

function populateProviders() {
  el.provider.replaceChildren();
  for (const provider of providers()) {
    const option = document.createElement("option");
    option.value = provider.id;
    option.textContent = provider.configured ? provider.label : `${provider.label} (no key)`;
    el.provider.append(option);
  }
}

function populateModels(providerId, selectedModel) {
  const provider = getProvider(providerId);
  el.model.replaceChildren();
  if (!provider) return;

  for (const model of provider.models) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = model.label;
    el.model.append(option);
  }

  // Model ids move faster than this catalog does, so any id can be typed in.
  const custom = document.createElement("option");
  custom.value = CUSTOM_MODEL;
  custom.textContent = "Custom…";
  el.model.append(custom);

  const known = provider.models.some((m) => m.id === selectedModel);
  if (selectedModel && !known) {
    el.model.value = CUSTOM_MODEL;
    el.customModel.value = selectedModel;
  } else {
    el.model.value = selectedModel || provider.models[0]?.id || CUSTOM_MODEL;
  }
  syncCustomModelVisibility();
}

function syncCustomModelVisibility() {
  el.customModel.hidden = el.model.value !== CUSTOM_MODEL;
}

// Temperature is not universal: the current Anthropic models and the OpenAI
// reasoning models reject it outright, so the control reflects that rather
// than sending a value the API will 400 on.
function syncCapabilities() {
  const caps = capsFor(el.provider.value, currentModel());
  el.temperature.disabled = !caps.temperature;
  el.temperatureNote.textContent = caps.temperature
    ? ""
    : "This model doesn't accept a temperature; the setting is ignored.";
}

function syncProviderWarning() {
  const provider = getProvider(el.provider.value);
  if (provider && !provider.configured) {
    setStatus(
      `No API key for ${provider.label}. Set one with: wrangler secret put ${provider.keyVar}`,
      true
    );
  } else if (el.status.classList.contains("error")) {
    setStatus("");
  }
}

function applySettingsToControls() {
  const config = settings();
  el.system.value = config.system;
  el.temperature.value = config.temperature;
  el.temperatureValue.textContent = Number(config.temperature).toFixed(2);
  el.maxTokens.value = config.maxTokens;
  el.toolsEnabled.checked = Boolean(config.tools);
  el.useSocket.checked = Boolean(config.socket);
}

function describeTools() {
  const available = tools();
  if (available.length === 0) {
    el.toolsNote.textContent = "";
    return;
  }
  const names = available.map((tool) => tool.name).join(", ");
  // Worth stating plainly: enabling this means the model chooses what to
  // fetch, and whatever comes back is untrusted text going into the context.
  el.toolsNote.textContent =
    `Available: ${names}. The model decides when to call them, and fetched pages ` +
    `are untrusted — treat anything they say as content, not instructions.`;
}

// ---------- Sending ----------

function setBusy(busy) {
  el.send.disabled = busy;
  el.stop.hidden = !busy;
  el.prompt.disabled = busy;
}

async function send(text) {
  const model = currentModel();
  if (!model) {
    setStatus("Enter a model id first.", true);
    return;
  }

  const userMessage = addMessage({ role: "user", content: text });
  if (messages().length === 1) el.thread.replaceChildren();
  appendMessage(userMessage);
  scrollToBottom();

  // Added to the store up front so a completed reply persists without a second
  // bookkeeping step; it is removed again below if nothing ever arrives.
  const assistant = addMessage({ role: "assistant", content: "" });
  const handle = appendMessage(assistant);
  handle.setPlaceholder("…");
  scrollToBottom();

  inFlight = new AbortController();
  setBusy(true);
  setStatus(`Streaming from ${getProvider(el.provider.value)?.label ?? el.provider.value}…`);

  try {
    const body = {
      provider: el.provider.value,
      model,
      system: el.system.value.trim(),
      temperature: Number(el.temperature.value),
      maxTokens: Number(el.maxTokens.value),
      tools: el.toolsEnabled.checked,
      // The assistant turn in progress is empty, so it is filtered out here.
      messages: turnsForRequest(),
    };

    const transport = el.useSocket.checked
      ? await openSocket(body, inFlight.signal)
      : await openHttp(body, inFlight.signal);

    // Fixed for the turn: a mid-turn provider/model switch in the controls
    // shouldn't retroactively reprice tokens already spent on this message.
    const price = priceFor(el.provider.value, model);

    let streamError = null;
    // A turn with tool calls spans several upstream calls. Within one call the
    // usage figure is a running total that gets restated, so the latest value
    // for a round replaces the previous one and the rounds are added up.
    const usageByRound = new Map();
    const totalUsage = () => {
      const total = { input: 0, output: 0 };
      for (const round of usageByRound.values()) {
        total.input += round.input ?? 0;
        total.output += round.output ?? 0;
      }
      return total;
    };

    for await (const event of transport.events) {
      const stick = nearBottom();
      if (event.type === "text") handle.appendText(event.text);
      else if (event.type === "thinking") handle.appendThinking(event.text);
      else if (event.type === "tool_call") {
        handle.addTool(event);
      } else if (event.type === "approval_request") {
        // The turn is paused server-side until this answer goes back.
        setStatus(`Waiting for you to approve ${event.name}…`);
        handle.askApproval(event.id, (approved) => {
          transport.respond(event.id, approved);
          setStatus(approved ? "Running…" : "Declined.");
        });
      } else if (event.type === "continue_request") {
        setStatus("Waiting for you — continue tool calls?");
        handle.askContinue(event.rounds, (approved) => {
          transport.respond(event.id, approved);
          setStatus(approved ? "Continuing…" : "Stopping.");
        });
      } else if (event.type === "tool_result") {
        handle.resolveTool(event);
      } else if (event.type === "meta") {
        usageByRound.set(event.round ?? 0, event.usage ?? {});
        handle.setMeta(describeMeta({ stopReason: event.stopReason, usage: totalUsage(), price }));
      } else if (event.type === "error") streamError = event.message;
      if (stick) scrollToBottom();
    }
    handle.settleTools();

    if (streamError) throw new Error(streamError);

    if (!assistant.content && !assistant.thinking && !assistant.tools?.length) {
      removeMessage(assistant);
      handle.el.remove();
      setStatus("The model returned no content.", true);
    } else {
      setStatus("");
    }
  } catch (err) {
    // Whatever went wrong, no tool is still running.
    handle.settleTools();
    if (err.name === "AbortError") {
      handle.setMeta([assistant.meta, "stopped"].filter(Boolean).join(" · "));
      setStatus("Stopped.");
    } else {
      // Keep whatever streamed before the failure, and show the failure as its
      // own entry so the transcript stays a faithful record of the exchange.
      if (!assistant.content && !assistant.thinking && !assistant.tools?.length) {
        removeMessage(assistant);
        handle.el.remove();
      }
      appendMessage(addMessage({ role: "error", content: String(err.message || err) }));
      setStatus("Request failed.", true);
      scrollToBottom();
    }
  } finally {
    commit();
    inFlight = null;
    setBusy(false);
    el.prompt.focus();
  }
}

// ---------- Events ----------

el.provider.addEventListener("change", () => {
  const provider = getProvider(el.provider.value);
  populateModels(el.provider.value, provider?.models[0]?.id ?? "");
  updateSettings({ provider: el.provider.value, model: currentModel() });
  syncCapabilities();
  syncProviderWarning();
});

el.model.addEventListener("change", () => {
  syncCustomModelVisibility();
  if (el.model.value === CUSTOM_MODEL) el.customModel.focus();
  updateSettings({ model: currentModel() });
  syncCapabilities();
});

el.customModel.addEventListener("input", () => {
  updateSettings({ model: currentModel() });
  syncCapabilities();
});

el.toggleSettings.addEventListener("click", () => {
  const open = el.settings.hidden;
  el.settings.hidden = !open;
  el.toggleSettings.setAttribute("aria-expanded", String(open));
});

el.newChat.addEventListener("click", () => {
  inFlight?.abort();
  clearMessages();
  renderThread();
  setStatus("");
  el.prompt.focus();
});

el.system.addEventListener("input", () => updateSettings({ system: el.system.value }));

el.temperature.addEventListener("input", () => {
  el.temperatureValue.textContent = Number(el.temperature.value).toFixed(2);
  updateSettings({ temperature: Number(el.temperature.value) });
});

el.maxTokens.addEventListener("change", () =>
  updateSettings({ maxTokens: Number(el.maxTokens.value) })
);

el.toolsEnabled.addEventListener("change", () =>
  updateSettings({ tools: el.toolsEnabled.checked })
);

el.useSocket.addEventListener("change", () => updateSettings({ socket: el.useSocket.checked }));

el.stop.addEventListener("click", () => inFlight?.abort());

el.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = el.prompt.value.trim();
  if (!text || inFlight) return;
  el.prompt.value = "";
  send(text);
});

el.prompt.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    el.composer.requestSubmit();
  }
});

// ---------- Boot ----------

async function boot() {
  load();
  renderThread();

  // Run together: syncFromRemote never throws (it's best-effort), so this
  // waits on the catalog fetch's success or failure either way. Applying
  // settings once, after both land, avoids painting controls with stale
  // local values just before a remote value overwrites them.
  try {
    await Promise.all([loadCatalog(), syncFromRemote()]);
  } catch (err) {
    setStatus(String(err.message || err), true);
    return;
  }
  applySettingsToControls();

  populateProviders();
  describeTools();
  const config = settings();
  const provider = getProvider(config.provider) || defaultProvider();
  if (!provider) {
    setStatus("No providers are available.", true);
    return;
  }

  el.provider.value = provider.id;
  populateModels(provider.id, config.model);
  updateSettings({ provider: provider.id, model: currentModel() });
  syncCapabilities();
  syncProviderWarning();
  el.prompt.focus();
}

boot();
