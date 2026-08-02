// Reads the normalized event stream the Worker sends back. One format here,
// because the Worker has already flattened every provider's SSE dialect into
// { type: "text" | "thinking" | "meta" | "error" | "done" }.

export async function* readEvents(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let split;
    while ((split = buffer.match(/\r?\n\r?\n/)) !== null) {
      const block = buffer.slice(0, split.index);
      buffer = buffer.slice(split.index + split[0].length);

      for (const line of block.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        try {
          yield JSON.parse(line.slice(5).trim());
        } catch {
          // Ignore a frame we can't parse rather than ending the stream.
        }
      }
    }
  }
}
