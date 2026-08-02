// WebSocket transport — a spike.
//
// The SSE path streams a turn down a one-way response, which leaves nowhere
// for the browser to answer a question mid-turn. A socket is two-way, so the
// Worker can pause before a destructive tool and wait for a decision.
//
// This deliberately reuses the same normalized events as the SSE path. The
// agent loop already writes everything through one `emit` callback and doesn't
// know what it points at, so the transport swap is confined to this file.
//
// Known limitation of the plain-Worker approach: a Worker is stateless and has
// no guaranteed lifetime, so a long-lived socket is best-effort. That is what
// Durable Objects exist for. This spike is here to find out whether the rest
// of the design holds up before taking on that machinery.

const APPROVAL_TIMEOUT_MS = 120_000;

export function isUpgrade(request) {
  return (request.headers.get("Upgrade") || "").toLowerCase() === "websocket";
}

// `startTurn` runs one agent turn, given an emit callback and an approve hook.
// It is passed in rather than imported so this file stays transport-only.
export function handleSocket(request, startTurn) {
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();

  // Resolvers for approvals the Worker is currently blocked on.
  const pending = new Map();
  let turn = null;

  const send = (event) => {
    try {
      server.send(JSON.stringify(event));
    } catch {
      // The socket went away mid-turn; the abort below handles the rest.
    }
  };

  const settle = (id, approved) => {
    const resolve = pending.get(id);
    if (!resolve) return;
    pending.delete(id);
    resolve(approved);
  };

  // Asks the browser and blocks the agent loop until it answers. A socket that
  // closes, or a user who wanders off, resolves as a refusal rather than
  // hanging the turn open — failing closed is the right default for questions
  // that are only asked because the alternative is worse.
  const ask = (id, event) =>
    new Promise((resolve) => {
      pending.set(id, resolve);
      send(event);
      setTimeout(() => settle(id, false), APPROVAL_TIMEOUT_MS);
    });

  const approve = (call) =>
    ask(call.id, { type: "approval_request", id: call.id, name: call.name, summary: call.summary });

  const askContinue = ({ rounds }) => {
    const id = crypto.randomUUID();
    return ask(id, { type: "continue_request", id, rounds });
  };

  server.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(typeof event.data === "string" ? event.data : "");
    } catch {
      return send({ type: "error", message: "Could not parse that message." });
    }

    if (message?.type === "approval") return settle(message.id, message.approved === true);

    if (message?.type === "cancel") {
      turn?.controller.abort();
      return;
    }

    if (message?.type !== "chat") return;

    // One turn at a time per socket: the conversation is a sequence, and
    // interleaving two turns would corrupt the history the model sees.
    if (turn) return send({ type: "error", message: "A turn is already in progress." });

    const controller = new AbortController();
    turn = { controller };

    // Not awaited: the message handler must return so further messages —
    // approvals and cancels — can still be delivered while the turn runs.
    (async () => {
      try {
        await startTurn({
          body: message.body,
          emit: send,
          approve,
          askContinue,
          signal: controller.signal,
        });
      } catch (err) {
        if (err?.name !== "AbortError") send({ type: "error", message: `Request failed: ${err}` });
      } finally {
        send({ type: "done" });
        turn = null;
        for (const id of [...pending.keys()]) settle(id, false);
      }
    })();
  });

  const shutDown = () => {
    turn?.controller.abort();
    for (const id of [...pending.keys()]) settle(id, false);
  };
  server.addEventListener("close", shutDown);
  server.addEventListener("error", shutDown);

  return new Response(null, { status: 101, webSocket: client });
}
