// Two ways to run a turn, behind one interface.
//
// Both yield the same normalized events, so the send loop doesn't branch on
// which is in use. The difference is that the socket can carry a message back
// mid-turn, which is what makes an approval prompt possible at all.
//
//   { events, respond(id, approved), cancel() }

import { readEvents } from "./sse.js";

// A queue an event source pushes into and a `for await` pulls out of.
function eventQueue() {
  const waiting = [];
  const buffered = [];
  let finished = false;

  return {
    push(event) {
      const next = waiting.shift();
      if (next) next({ value: event, done: false });
      else buffered.push(event);
    },
    finish() {
      finished = true;
      let next;
      while ((next = waiting.shift())) next({ value: undefined, done: true });
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (buffered.length) return Promise.resolve({ value: buffered.shift(), done: false });
          if (finished) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => waiting.push(resolve));
        },
      };
    },
  };
}

// HTTP + SSE: one POST, one one-way stream. `respond` is a no-op because the
// Worker never asks anything on this path.
export async function openHttp(body, signal) {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const failure = await response.json().catch(() => ({}));
    throw new Error(
      [failure.error, failure.details].filter(Boolean).join(" — ") || `HTTP ${response.status}`
    );
  }

  return { events: readEvents(response), respond() {}, cancel() {} };
}

export function openSocket(body, signal) {
  return new Promise((resolve, reject) => {
    const url = new URL("/api/socket", location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    const queue = eventQueue();
    let opened = false;

    socket.addEventListener("open", () => {
      opened = true;
      socket.send(JSON.stringify({ type: "chat", body }));
      resolve({
        events: queue,
        respond(id, approved) {
          socket.send(JSON.stringify({ type: "approval", id, approved }));
        },
        cancel() {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "cancel" }));
        },
      });
    });

    socket.addEventListener("message", (event) => {
      let parsed;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      if (parsed.type === "done") {
        queue.finish();
        socket.close();
        return;
      }
      queue.push(parsed);
    });

    // A socket that dies before the turn ends looks like any other mid-stream
    // failure, so report it as one rather than stalling.
    socket.addEventListener("close", () => {
      if (!opened) return reject(new Error("The connection closed before it opened."));
      queue.push({ type: "error", message: "The connection closed before the turn finished." });
      queue.finish();
    });

    socket.addEventListener("error", () => {
      if (!opened) reject(new Error("Could not open a WebSocket connection."));
    });

    signal?.addEventListener("abort", () => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "cancel" }));
      socket.close();
    });
  });
}
