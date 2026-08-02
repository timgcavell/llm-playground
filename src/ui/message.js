// One message in the transcript. Returns a handle rather than markup, because
// an assistant message is written to incrementally as tokens arrive.
//
// Content is set with textContent throughout: model output and fetched web
// pages are both untrusted, and the CSS renders them with
// `white-space: pre-wrap`, so there is no reason to ever parse them as HTML.

const ROLE_LABELS = {
  user: "You",
  assistant: "Assistant",
  error: "Error",
};

const TOOL_STATES = {
  running: "running…",
  ok: "done",
  error: "failed",
};

// A tool call renders as a collapsed row that expands to the raw result, so
// the transcript stays readable but nothing the model saw is hidden.
function renderTool(tool) {
  const el = document.createElement("details");
  el.className = `tool ${tool.status}`;

  const summary = document.createElement("summary");
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = tool.name;
  const target = document.createElement("span");
  target.className = "target";
  target.textContent = tool.summary ? ` ${tool.summary} ` : " ";
  const state = document.createElement("span");
  state.className = "state";
  state.textContent = TOOL_STATES[tool.status] ?? tool.status;
  summary.append(name, target, state);

  const output = document.createElement("div");
  output.className = "output";
  output.textContent = tool.content || "";
  output.hidden = !tool.content;

  el.append(summary, output);

  return {
    el,
    resolve(update) {
      Object.assign(tool, update);
      el.className = `tool ${tool.status}`;
      state.textContent = TOOL_STATES[tool.status] ?? tool.status;
      target.textContent = tool.summary ? ` ${tool.summary} ` : " ";
      output.textContent = tool.content || "";
      output.hidden = !tool.content;
    },
  };
}

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

  const tools = document.createElement("div");
  tools.className = "tools";

  const body = document.createElement("div");
  body.className = "body";
  body.textContent = message.content || "";

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.hidden = true;

  el.append(role, thinking, tools, body, meta);

  // Tool handles are tracked by id so a result can find the call it belongs to.
  const toolHandles = new Map();

  if (message.thinking) {
    thinkingBody.textContent = message.thinking;
    thinking.hidden = false;
  }
  for (const tool of message.tools ?? []) {
    const handle = renderTool(tool);
    toolHandles.set(tool.id, handle);
    tools.append(handle.el);
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
    addTool({ id, name, summary: label }) {
      const tool = { id, name, summary: label, status: "running", content: "" };
      (message.tools ??= []).push(tool);
      const handle = renderTool(tool);
      toolHandles.set(id, handle);
      tools.append(handle.el);
    },
    resolveTool({ id, ok, content, summary: label }) {
      const handle = toolHandles.get(id);
      if (!handle) return;
      handle.resolve({ status: ok ? "ok" : "error", content, summary: label });
    },
    // A response that is cut off mid-tool leaves rows spinning forever.
    settleTools() {
      for (const tool of message.tools ?? []) {
        if (tool.status !== "running") continue;
        toolHandles.get(tool.id)?.resolve({ status: "error", content: tool.content || "" });
      }
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
  const settled = ["end_turn", "stop", "STOP", "tool_use", "tool_calls"];
  if (stopReason && !settled.includes(stopReason)) parts.push(`stopped: ${stopReason}`);
  return parts.join(" · ");
}
