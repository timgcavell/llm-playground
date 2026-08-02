// The agent loop.
//
// Without tools this is a single upstream call piped through. With tools it
// becomes a loop: stream a turn, run whatever tools the model asked for, hand
// the results back, stream the next turn. The browser sees one continuous
// event stream either way, so a tool call is a rendering detail rather than a
// protocol change.
//
// The loop lives here rather than in the browser because the API keys do. It
// also means the conversation the browser stores never contains vendor-native
// tool blocks: one exchange in, one assistant reply out.

import { consumeSse } from "./stream.js";
import { availableTools, runTool, summarizeCall } from "./tools.js";

// Rounds of tool use per message. Each round is another upstream call, so this
// bounds both cost and latency for a single send.
const MAX_TOOL_ROUNDS = 5;

async function upstreamError(response) {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text);
    return parsed?.error?.message || parsed?.message || text;
  } catch {
    return text;
  }
}

// One prompt, one answer, no tools and no history. This is what backs the
// ask_model tool: the model being asked cannot call tools of its own, which is
// also what stops two models from calling each other in a loop.
export async function runOnce({ provider, key, model, caps, prompt, maxTokens }) {
  const { url, init } = provider.request({
    key,
    model,
    caps,
    system: "",
    messages: [{ role: "user", content: prompt }],
    temperature: null,
    maxTokens,
    tools: null,
    extraTurns: [],
  });

  const upstream = await fetch(url, init);
  if (!upstream.ok || !upstream.body) {
    return {
      ok: false,
      content: `${provider.label} returned ${upstream.status}: ${await upstreamError(upstream)}`,
    };
  }

  const state = {};
  let text = "";
  await consumeSse(upstream, async (data) => {
    let events;
    try {
      events = provider.parse(data, state);
    } catch {
      return;
    }
    for (const event of events) if (event.type === "text") text += event.text;
  });

  return { ok: true, content: text.trim() || "(the model returned no text)" };
}

export async function runAgent(request, emit) {
  const { provider, useTools } = request;
  const tools = useTools ? availableTools(request.toolContext) : null;
  const extraTurns = [];

  for (let round = 0; ; round++) {
    const state = {};
    const calls = [];

    const { url, init } = provider.request({ ...request, tools, extraTurns });
    const upstream = await fetch(url, init);

    if (!upstream.ok || !upstream.body) {
      await emit({
        type: "error",
        message: `${provider.label} returned ${upstream.status}: ${await upstreamError(upstream)}`,
      });
      return;
    }

    await consumeSse(upstream, async (data) => {
      let events;
      try {
        events = provider.parse(data, state);
      } catch {
        // A payload we can't parse is not worth killing the stream over; the
        // model's own output is still flowing.
        return;
      }
      for (const event of events) {
        if (event.type === "tool_call") {
          calls.push(event);
          // Label the call for the transcript here, so the browser never has
          // to know the shape of any particular tool's arguments.
          await emit({ ...event, summary: summarizeCall(event.name, event.input) });
          continue;
        }
        if (event.type === "meta") {
          // Usage is reported per upstream call, and some providers restate a
          // running total on every chunk. Tagging the round lets the browser
          // overwrite within a round and add up across rounds, instead of
          // summing restatements.
          await emit({ ...event, round });
          continue;
        }
        await emit(event);
      }
    });

    // No tool calls means the model is done talking.
    if (calls.length === 0) return;

    if (round >= MAX_TOOL_ROUNDS - 1) {
      await emit({
        type: "error",
        message: `Stopped after ${MAX_TOOL_ROUNDS} rounds of tool calls.`,
      });
      return;
    }

    // Independent calls in one turn, so run them together rather than serially.
    const results = await Promise.all(
      calls.map(async (call) => {
        const { ok, content } = await runTool(call.name, call.input, request.toolContext);
        return { id: call.id, name: call.name, ok, content };
      })
    );

    for (const result of results) {
      await emit({
        type: "tool_result",
        id: result.id,
        name: result.name,
        ok: result.ok,
        summary: summarizeCall(result.name, calls.find((c) => c.id === result.id)?.input),
        content: result.content,
      });
    }

    extraTurns.push(...provider.assistantTurn(state), ...provider.resultTurn(results));
  }
}
