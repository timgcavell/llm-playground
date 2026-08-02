// Server-Sent Events plumbing, in both directions.
//
// Inbound: every provider streams SSE, but each frames its payloads
// differently. `consumeSse` handles the framing and hands each `data:` payload
// to a callback.
//
// Outbound: `createEventStream` is the channel the agent loop writes normalized
// events to. It exists separately from any one upstream response because a
// single browser request can span several upstream calls when tools are in
// play — the browser sees one continuous stream regardless.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function createEventStream() {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();

  return {
    readable,
    async emit(event) {
      await writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    },
    async close() {
      await writer.close();
    },
  };
}

// Pull the `data:` payloads out of one SSE block, ignoring `event:`/`id:`/
// comment lines. Multi-line data fields are joined with newlines per the spec.
function dataFromBlock(block) {
  const lines = block.split(/\r?\n/).filter((line) => line.startsWith("data:"));
  if (lines.length === 0) return null;
  return lines.map((line) => line.slice(5).trimStart()).join("\n");
}

// Reads an upstream SSE response to completion, awaiting `onData` for each
// payload so that backpressure from the browser reaches the provider.
export async function consumeSse(response, onData) {
  const reader = response.body.getReader();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let split;
    while ((split = buffer.match(/\r?\n\r?\n/)) !== null) {
      const block = buffer.slice(0, split.index);
      buffer = buffer.slice(split.index + split[0].length);

      const data = dataFromBlock(block);
      if (data !== null) await onData(data);
    }
  }
}

export function sseHeaders() {
  return {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  };
}
