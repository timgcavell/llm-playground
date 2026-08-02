// One message in the transcript. Returns a handle rather than markup, because
// an assistant message is written to incrementally as tokens arrive.
//
// Content is set with textContent throughout: model output is untrusted, and
// the CSS renders it with `white-space: pre-wrap`, so there is no reason to
// ever parse it as HTML.

const ROLE_LABELS = {
  user: "You",
  assistant: "Assistant",
  error: "Error",
};

export function renderMessage(message) {
  const el = document.createElement("article");
  el.className = `message ${message.role}`;

  const role = document.createElement("div");
  role.className = "role";
  role.textContent = ROLE_LABELS[message.role] || message.role;

  const thinking = document.createElement("details");
  thinking.className = "thinking";
  thinking.hidden = true;
  const summary = document.createElement("summary");
  summary.textContent = "Reasoning";
  const thinkingBody = document.createElement("div");
  thinkingBody.className = "body";
  thinking.append(summary, thinkingBody);

  const body = document.createElement("div");
  body.className = "body";
  body.textContent = message.content || "";

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.hidden = true;

  el.append(role, thinking, body, meta);

  if (message.thinking) {
    thinkingBody.textContent = message.thinking;
    thinking.hidden = false;
  }
  if (message.meta) {
    meta.textContent = message.meta;
    meta.hidden = false;
  }

  return {
    el,
    appendText(text) {
      message.content += text;
      body.textContent = message.content;
    },
    appendThinking(text) {
      message.thinking = (message.thinking || "") + text;
      thinkingBody.textContent = message.thinking;
      thinking.hidden = false;
    },
    setMeta(text) {
      message.meta = text;
      meta.textContent = text;
      meta.hidden = !text;
    },
    setPlaceholder(text) {
      // Shown only while nothing has streamed in yet.
      if (!message.content) body.textContent = text;
    },
  };
}

export function describeMeta({ stopReason, usage }) {
  const parts = [];
  if (usage && (usage.input || usage.output)) {
    parts.push(`${usage.input} in / ${usage.output} out tokens`);
  }
  if (stopReason && stopReason !== "end_turn" && stopReason !== "stop" && stopReason !== "STOP") {
    parts.push(`stopped: ${stopReason}`);
  }
  return parts.join(" · ");
}
