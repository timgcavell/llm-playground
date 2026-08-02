// Provider adapters.
//
// Every provider is described by the same three things, so nothing above this
// file knows which vendor is being talked to:
//
//   models   capability flags the UI needs (does this model take a
//            temperature? does it stream reasoning?)
//   request  turn a normalized chat request into an upstream fetch
//   parse    turn one upstream SSE `data:` payload into normalized events
//
// Normalized events are the only shape the Worker streams to the browser:
//   { type: "text",     text }      assistant output
//   { type: "thinking", text }      reasoning, where the model exposes it
//   { type: "meta",     stopReason, usage: { input, output } }
//   { type: "error",    message }   upstream failure mid-stream
//
// Adding a provider means adding one entry here. Nothing else changes.

// Capability flags per model:
//   temperature  false where the API rejects sampling parameters outright
//   thinking     model streams reasoning we can surface separately
const ANTHROPIC_VERSION = "2023-06-01";

export const PROVIDERS = {
  anthropic: {
    label: "Anthropic",
    keyVar: "ANTHROPIC_API_KEY",
    // Current Anthropic models reject temperature/top_p with a 400, so an
    // unrecognized model is assumed to behave the same way.
    defaultCaps: { temperature: false, thinking: true },
    models: [
      { id: "claude-opus-5", label: "Claude Opus 5", temperature: false, thinking: true },
      { id: "claude-sonnet-5", label: "Claude Sonnet 5", temperature: false, thinking: true },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", temperature: true, thinking: false },
    ],

    request({ key, model, caps, system, messages, temperature, maxTokens }) {
      const body = {
        model,
        max_tokens: maxTokens,
        stream: true,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      };
      if (system) body.system = system;
      // Adaptive thinking is on by default on the 5-series; asking for the
      // summary is what makes it visible in the transcript.
      if (caps.thinking) body.thinking = { type: "adaptive", display: "summarized" };
      if (caps.temperature && temperature != null) body.temperature = temperature;

      return {
        url: "https://api.anthropic.com/v1/messages",
        init: {
          method: "POST",
          headers: {
            "x-api-key": key,
            "anthropic-version": ANTHROPIC_VERSION,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        },
      };
    },

    parse(data, state) {
      const chunk = JSON.parse(data);
      switch (chunk.type) {
        case "message_start":
          state.input = chunk.message?.usage?.input_tokens ?? 0;
          return [];
        case "content_block_delta":
          if (chunk.delta?.type === "text_delta") return [{ type: "text", text: chunk.delta.text }];
          if (chunk.delta?.type === "thinking_delta")
            return [{ type: "thinking", text: chunk.delta.thinking }];
          return [];
        case "message_delta":
          return [
            {
              type: "meta",
              stopReason: chunk.delta?.stop_reason ?? null,
              usage: { input: state.input ?? 0, output: chunk.usage?.output_tokens ?? 0 },
            },
          ];
        case "error":
          return [{ type: "error", message: chunk.error?.message || "Upstream error" }];
        default:
          return [];
      }
    },
  },

  google: {
    label: "Google Gemini",
    keyVar: "GEMINI_API_KEY",
    defaultCaps: { temperature: true, thinking: false },
    models: [
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", temperature: true, thinking: true },
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", temperature: true, thinking: true },
      {
        id: "gemini-2.5-flash-lite",
        label: "Gemini 2.5 Flash Lite",
        temperature: true,
        thinking: false,
      },
    ],

    request({ key, model, caps, system, messages, temperature, maxTokens }) {
      const body = {
        contents: messages.map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        })),
        generationConfig: { maxOutputTokens: maxTokens },
      };
      if (system) body.systemInstruction = { parts: [{ text: system }] };
      if (caps.temperature && temperature != null) body.generationConfig.temperature = temperature;

      return {
        url:
          "https://generativelanguage.googleapis.com/v1beta/models/" +
          `${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
        init: {
          method: "POST",
          headers: { "x-goog-api-key": key, "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      };
    },

    parse(data) {
      const chunk = JSON.parse(data);
      if (chunk.error) return [{ type: "error", message: chunk.error.message || "Upstream error" }];

      const events = [];
      const candidate = chunk.candidates?.[0];
      // Gemini marks reasoning with `thought: true` on the part rather than
      // giving it its own event type.
      for (const part of candidate?.content?.parts ?? []) {
        if (typeof part.text !== "string") continue;
        events.push({ type: part.thought ? "thinking" : "text", text: part.text });
      }
      if (candidate?.finishReason || chunk.usageMetadata) {
        events.push({
          type: "meta",
          stopReason: candidate?.finishReason ?? null,
          usage: {
            input: chunk.usageMetadata?.promptTokenCount ?? 0,
            output: chunk.usageMetadata?.candidatesTokenCount ?? 0,
          },
        });
      }
      return events;
    },
  },

  openai: {
    label: "OpenAI",
    keyVar: "OPENAI_API_KEY",
    defaultCaps: { temperature: true, thinking: false },
    models: [
      { id: "gpt-4.1", label: "GPT-4.1", temperature: true, thinking: false },
      { id: "gpt-4.1-mini", label: "GPT-4.1 mini", temperature: true, thinking: false },
      { id: "gpt-4o", label: "GPT-4o", temperature: true, thinking: false },
      // Reasoning models reject temperature and keep their reasoning private.
      { id: "o3", label: "o3", temperature: false, thinking: false },
      { id: "o4-mini", label: "o4-mini", temperature: false, thinking: false },
    ],

    request({ key, model, caps, system, messages, temperature, maxTokens }) {
      const body = {
        model,
        stream: true,
        stream_options: { include_usage: true },
        max_completion_tokens: maxTokens,
        messages: system ? [{ role: "system", content: system }, ...messages] : messages,
      };
      if (caps.temperature && temperature != null) body.temperature = temperature;

      return {
        url: "https://api.openai.com/v1/chat/completions",
        init: {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      };
    },

    parse(data) {
      if (data === "[DONE]") return [];
      const chunk = JSON.parse(data);
      if (chunk.error) return [{ type: "error", message: chunk.error.message || "Upstream error" }];

      const events = [];
      const choice = chunk.choices?.[0];
      if (choice?.delta?.content) events.push({ type: "text", text: choice.delta.content });
      if (choice?.finish_reason || chunk.usage) {
        events.push({
          type: "meta",
          stopReason: choice?.finish_reason ?? null,
          usage: {
            input: chunk.usage?.prompt_tokens ?? 0,
            output: chunk.usage?.completion_tokens ?? 0,
          },
        });
      }
      return events;
    },
  },
};

// Capability lookup that tolerates a model typed by hand: a model the catalog
// doesn't list still works, it just falls back to the provider's defaults.
export function modelCaps(provider, modelId) {
  const known = provider.models.find((m) => m.id === modelId);
  return known ? { temperature: known.temperature, thinking: known.thinking } : provider.defaultCaps;
}

// What the browser is allowed to know: the catalog, plus whether a key exists.
// Never the key itself.
export function describeProviders(env) {
  return Object.entries(PROVIDERS).map(([id, provider]) => ({
    id,
    label: provider.label,
    configured: Boolean(env[provider.keyVar]),
    keyVar: provider.keyVar,
    models: provider.models,
    defaultCaps: provider.defaultCaps,
  }));
}
