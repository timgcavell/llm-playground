// Server-Sent Events plumbing.
//
// Every provider streams SSE, but each frames its payloads differently. This
// reads the upstream stream, hands each `data:` payload to the provider's
// parser, and re-emits the normalized events as our own SSE — so the browser
// only ever parses one format.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function frame(event) {
  return encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
}

// Pull the `data:` payloads out of one SSE block, ignoring `event:`/`id:`/
// comment lines. Multi-line data fields are joined with newlines per the spec.
function dataFromBlock(block) {
  const lines = block.split(/\r?\n/).filter((line) => line.startsWith("data:"));
  if (lines.length === 0) return null;
  return lines.map((line) => line.slice(5).trimStart()).join("\n");
}

export function normalizeStream(upstream, provider) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();

  // Not awaited: the response returns immediately and this keeps writing as
  // upstream bytes arrive. Cancelling the response cancels the reader.
  (async () => {
    const reader = upstream.body.getReader();
    // Per-response scratch space for parsers that need to correlate events
    // across chunks (Anthropic reports input tokens in message_start but
    // output tokens only at the end).
    const state = {};
    let buffer = "";

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let split;
        while ((split = buffer.match(/\r?\n\r?\n/)) !== null) {
          const block = buffer.slice(0, split.index);
          buffer = buffer.slice(split.index + split[0].length);

          const data = dataFromBlock(block);
          if (data === null) continue;

          let events;
          try {
            events = provider.parse(data, state);
          } catch {
            // A payload we can't parse is not worth killing the stream over;
            // the model's own output is still flowing.
            continue;
          }
          for (const event of events) await writer.write(frame(event));
        }
      }
    } catch (err) {
      await writer.write(frame({ type: "error", message: `Stream failed: ${err}` }));
    } finally {
      await writer.write(frame({ type: "done" }));
      await writer.close();
    }
  })();

  return readable;
}

export function sseHeaders() {
  return {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  };
}
