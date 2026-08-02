// Provider adapters.
//
// Every provider is described by the same handful of things, so nothing above
// this file knows which vendor is being talked to:
//
//   models         capability flags the UI needs (does this model take a
//                  temperature? does it stream reasoning?)
//   request        turn a normalized chat request into an upstream fetch
//   parse          turn one upstream SSE `data:` payload into normalized events
//   assistantTurn  rebuild the assistant turn that just streamed, natively
//   resultTurn     phrase tool results the way this vendor expects them back
//
// Normalized events are the only shape the Worker streams to the browser:
//   { type: "text",      text }             assistant output
//   { type: "thinking",  text }             reasoning, where the model exposes it
//   { type: "tool_call", id, name, input }  model wants a tool run
//   { type: "meta",      stopReason, usage: { input, output } }
//   { type: "error",     message }          upstream failure mid-stream
//
// The last two functions exist because tool calling is a loop: the assistant
// turn containing the tool call has to be sent back verbatim alongside the
// result. "Verbatim" is the operative word — reasoning blocks carry signatures
// that the provider validates — so `parse` accumulates the raw native content
// as it streams rather than trying to reconstruct it afterwards.
//
// Adding a provider means adding one entry here. Nothing else changes.

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

    request({ key, model, caps, system, messages, temperature, maxTokens, tools = null, extraTurns = [] }) {
      const body = {
        model,
        max_tokens: maxTokens,
        stream: true,
        messages: [
          ...messages.map((m) => ({ role: m.role, content: m.content })),
          ...extraTurns,
        ],
      };
      if (system) body.system = system;
      // Adaptive thinking is on by default on the 5-series; asking for the
      // summary is what makes it visible in the transcript. It also has to stay
      // on during tool use: with thinking disabled these models sometimes
      // describe a tool call in prose instead of emitting a real tool_use block.
      if (caps.thinking) body.thinking = { type: "adaptive", display: "summarized" };
      if (caps.temperature && temperature != null) body.temperature = temperature;
      if (tools?.length) {
        body.tools = tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.schema,
        }));
      }

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
      state.blocks ??= [];
      state.partialJson ??= {};

      switch (chunk.type) {
        case "message_start":
          state.input = chunk.message?.usage?.input_tokens ?? 0;
          return [];

        case "content_block_start":
          // Keep the block skeleton exactly as sent; deltas fill it in.
          state.blocks[chunk.index] = { ...chunk.content_block };
          if (chunk.content_block?.type === "tool_use") state.partialJson[chunk.index] = "";
          return [];

        case "content_block_delta": {
          const block = state.blocks[chunk.index];
          const delta = chunk.delta ?? {};
          if (delta.type === "text_delta") {
            if (block) block.text = (block.text || "") + delta.text;
            return [{ type: "text", text: delta.text }];
          }
          if (delta.type === "thinking_delta") {
            if (block) block.thinking = (block.thinking || "") + delta.thinking;
            return [{ type: "thinking", text: delta.thinking }];
          }
          if (delta.type === "signature_delta") {
            // Carries no visible content, but the block is rejected on the way
            // back without it.
            if (block) block.signature = (block.signature || "") + delta.signature;
            return [];
          }
          if (delta.type === "input_json_delta") {
            state.partialJson[chunk.index] = (state.partialJson[chunk.index] || "") + delta.partial_json;
            return [];
          }
          return [];
        }

        case "content_block_stop": {
          const block = state.blocks[chunk.index];
          if (block?.type !== "tool_use") return [];
          try {
            block.input = JSON.parse(state.partialJson[chunk.index] || "{}");
          } catch {
            block.input = {};
          }
          return [{ type: "tool_call", id: block.id, name: block.name, input: block.input }];
        }

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

    assistantTurn(state) {
      const content = (state.blocks ?? []).filter(Boolean);
      return content.length ? [{ role: "assistant", content }] : [];
    },

    resultTurn(results) {
      return [
        {
          role: "user",
          content: results.map((result) => ({
            type: "tool_result",
            tool_use_id: result.id,
            content: result.content,
            is_error: !result.ok,
          })),
        },
      ];
    },
  },

  google: {
    label: "Google Gemini",
    keyVar: "GEMINI_API_KEY",
    defaultCaps: { temperature: true, thinking: false },
    models: [
      { id: "gemini-flash-latest", label: "Gemini Flash Latest", temperature: true, thinking: true },
      { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash", temperature: true, thinking: true },
      {
        id: "gemini-3.5-flash-lite",
        label: "Gemini 3.5 Flash Lite",
        temperature: true,
        thinking: false,
      },
    ],

    request({ key, model, caps, system, messages, temperature, maxTokens, tools = null, extraTurns = [] }) {
      const body = {
        contents: [
          ...messages.map((m) => ({
            role: m.role === "assistant" ? "model" : "user",
            parts: [{ text: m.content }],
          })),
          ...extraTurns,
        ],
        generationConfig: { maxOutputTokens: maxTokens },
      };
      if (system) body.systemInstruction = { parts: [{ text: system }] };
      if (caps.temperature && temperature != null) body.generationConfig.temperature = temperature;
      if (tools?.length) {
        body.tools = [
          {
            functionDeclarations: tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              parameters: tool.schema,
            })),
          },
        ];
      }

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

    parse(data, state) {
      const chunk = JSON.parse(data);
      if (chunk.error) return [{ type: "error", message: chunk.error.message || "Upstream error" }];

      state.parts ??= [];
      state.callCount ??= 0;

      const events = [];
      const candidate = chunk.candidates?.[0];

      for (const part of candidate?.content?.parts ?? []) {
        // Stored as sent: Gemini attaches thought signatures to parts, and they
        // have to survive the round trip through a tool call.
        state.parts.push(part);

        if (part.functionCall) {
          // Gemini function calls have no id of their own; results are matched
          // by name, so a local id is enough to pair call with result in the UI.
          const id = `${part.functionCall.name}-${state.callCount++}`;
          events.push({
            type: "tool_call",
            id,
            name: part.functionCall.name,
            input: part.functionCall.args ?? {},
          });
        } else if (typeof part.text === "string") {
          // Gemini marks reasoning with `thought: true` on the part rather than
          // giving it its own event type.
          events.push({ type: part.thought ? "thinking" : "text", text: part.text });
        }
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

    assistantTurn(state) {
      const parts = state.parts ?? [];
      return parts.length ? [{ role: "model", parts }] : [];
    },

    resultTurn(results) {
      return [
        {
          role: "user",
          parts: results.map((result) => ({
            functionResponse: {
              name: result.name,
              response: result.ok ? { result: result.content } : { error: result.content },
            },
          })),
        },
      ];
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

    request({ key, model, caps, system, messages, temperature, maxTokens, tools = null, extraTurns = [] }) {
      const body = {
        model,
        stream: true,
        stream_options: { include_usage: true },
        max_completion_tokens: maxTokens,
        messages: [
          ...(system ? [{ role: "system", content: system }] : []),
          ...messages,
          ...extraTurns,
        ],
      };
      if (caps.temperature && temperature != null) body.temperature = temperature;
      if (tools?.length) {
        body.tools = tools.map((tool) => ({
          type: "function",
          function: { name: tool.name, description: tool.description, parameters: tool.schema },
        }));
      }

      return {
        url: "https://api.openai.com/v1/chat/completions",
        init: {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      };
    },

    parse(data, state) {
      if (data === "[DONE]") return [];
      const chunk = JSON.parse(data);
      if (chunk.error) return [{ type: "error", message: chunk.error.message || "Upstream error" }];

      state.text ??= "";
      state.calls ??= [];

      const events = [];
      const choice = chunk.choices?.[0];

      if (choice?.delta?.content) {
        state.text += choice.delta.content;
        events.push({ type: "text", text: choice.delta.content });
      }

      // Tool calls stream as sparse deltas keyed by index: the id and name
      // arrive once, then the arguments accumulate as a JSON string.
      for (const delta of choice?.delta?.tool_calls ?? []) {
        const slot = (state.calls[delta.index] ??= { id: "", name: "", args: "" });
        if (delta.id) slot.id = delta.id;
        if (delta.function?.name) slot.name += delta.function.name;
        if (delta.function?.arguments) slot.args += delta.function.arguments;
      }

      if (choice?.finish_reason === "tool_calls") {
        for (const call of state.calls.filter(Boolean)) {
          let input = {};
          try {
            input = JSON.parse(call.args || "{}");
          } catch {
            input = {};
          }
          events.push({ type: "tool_call", id: call.id, name: call.name, input });
        }
      }

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

    assistantTurn(state) {
      const calls = (state.calls ?? []).filter(Boolean);
      if (!calls.length && !state.text) return [];
      const message = { role: "assistant", content: state.text || null };
      if (calls.length) {
        message.tool_calls = calls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.args || "{}" },
        }));
      }
      return [message];
    },

    resultTurn(results) {
      // One message per result here, unlike the other two vendors.
      return results.map((result) => ({
        role: "tool",
        tool_call_id: result.id,
        content: result.content,
      }));
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
