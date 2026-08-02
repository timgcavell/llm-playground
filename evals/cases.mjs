// The eval set: small, fixed tasks with mostly deterministic checks.
//
// Each case is one conversation turn through /api/chat. Checks run against
// what came back:
//
//   { type: "contains", value }            final text, case-insensitive
//   { type: "regex", value, flags }        final text
//   { type: "tool_called", name }          the named tool was called
//   { type: "no_tools_called" }            the model resisted its tools
//   { type: "tools_ok" }                   every tool result reported ok
//   { type: "judge", criteria }            an LLM judges the final text
//
// Prefer deterministic checks; reach for the judge only where a string match
// would be brittle. "{RUNID}" in prompts is replaced per run, so cases that
// write state (memory keys) never collide with a previous run.

export const CASES = [
  {
    id: "arithmetic-no-tools",
    tools: false,
    prompt: "What is 17 * 23? Reply with just the number.",
    checks: [{ type: "contains", value: "391" }],
  },
  {
    id: "tool-restraint",
    tools: true,
    prompt:
      "What is the capital of France? Answer from your own knowledge without using any tools.",
    checks: [{ type: "no_tools_called" }, { type: "contains", value: "Paris" }],
  },
  {
    id: "time-tool",
    tools: true,
    prompt: "What is the current date and time in Denver?",
    checks: [
      { type: "tool_called", name: "get_current_time" },
      { type: "tools_ok" },
      {
        type: "judge",
        // The judge has no clock, so it can only grade the shape of the
        // answer, never whether the stated time is actually right — the
        // first run failed a correct answer for being "in the future".
        criteria:
          "The answer states one specific, concrete date and time for Denver with a " +
          "Mountain Time zone marker (MDT or MST). You cannot verify the actual time, " +
          "so judge only that a definite answer was given rather than a guess, a range, " +
          "or a refusal.",
      },
    ],
  },
  {
    id: "fetch-h1",
    tools: true,
    prompt: "Fetch https://example.com and quote its H1 heading exactly.",
    checks: [
      { type: "tool_called", name: "fetch_url" },
      { type: "contains", value: "Example Domain" },
    ],
  },
  {
    id: "fetch-json-api",
    tools: true,
    prompt:
      "Using the GitHub API at https://api.github.com/repos/cloudflare/workers-sdk, " +
      "tell me what license the project uses.",
    checks: [
      { type: "tool_called", name: "fetch_url" },
      { type: "contains", value: "Apache" },
    ],
  },
  {
    id: "ssrf-report",
    tools: true,
    prompt:
      "Try to fetch http://169.254.169.254/latest/meta-data/ and tell me exactly what happened.",
    checks: [
      { type: "tool_called", name: "fetch_url" },
      {
        type: "judge",
        criteria:
          "The answer reports that the fetch was refused or blocked because private, " +
          "loopback, or link-local addresses are not allowed. It does not fabricate any " +
          "metadata content or claim the fetch succeeded.",
      },
    ],
  },
  {
    id: "memory-roundtrip",
    tools: true,
    prompt:
      "Save the text 'cobalt' under the memory key 'eval-{RUNID}', read the key back, " +
      "tell me the stored value, then delete that key.",
    checks: [
      { type: "tool_called", name: "save_memory" },
      { type: "tool_called", name: "read_memory" },
      { type: "tool_called", name: "delete_memory" },
      { type: "tools_ok" },
      { type: "contains", value: "cobalt" },
    ],
  },
];
