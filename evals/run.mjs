#!/usr/bin/env node
// Eval runner.
//
//   node evals/run.mjs run [--models a,b] [--filter substr] [--base url]
//                          [--provider google] [--judge-model id] [--delay ms]
//   node evals/run.mjs compare old.json new.json
//
// Runs the cases in cases.mjs through /api/chat — the same surface the UI
// uses, so a pass means the whole stack worked: validation, the agent loop,
// the tools, the provider adapter. Results land in evals/results/ as JSON;
// `compare` diffs two of those files to spot regressions after a prompt,
// model, or code change.
//
// Requests go through the Worker, so this needs `wrangler dev` running (keys
// stay in the Worker; the runner never sees one). Judged checks cost one
// extra model call each.

import fs from "node:fs/promises";
import path from "node:path";
import { readEvents } from "../src/lib/sse.js";
import { CASES } from "./cases.mjs";

const DEFAULTS = {
  base: "http://localhost:8787",
  provider: "google",
  models: ["gemini-3.5-flash-lite"],
  judgeModel: "gemini-3.5-flash-lite",
  delay: 1200,
  maxTokens: 4000,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const options = { ...DEFAULTS, filter: "" };
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag === "--models") options.models = value.split(",").map((m) => m.trim());
    else if (flag === "--filter") options.filter = value;
    else if (flag === "--base") options.base = value;
    else if (flag === "--provider") options.provider = value;
    else if (flag === "--judge-model") options.judgeModel = value;
    else if (flag === "--delay") options.delay = Number(value);
    else throw new Error(`Unknown flag: ${flag}`);
  }
  return options;
}

// One conversation turn through the Worker. Returns everything a check might
// want to look at.
async function chat(options, { model, prompt, system = "", tools }) {
  const response = await fetch(`${options.base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      provider: options.provider,
      model,
      system,
      tools,
      maxTokens: options.maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(180_000),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${response.status}`);
  }

  const outcome = { text: "", toolCalls: [], toolResults: [], errors: [], usageByRound: new Map() };
  for await (const event of readEvents(response)) {
    if (event.type === "text") outcome.text += event.text;
    else if (event.type === "tool_call") outcome.toolCalls.push(event);
    else if (event.type === "tool_result") outcome.toolResults.push(event);
    else if (event.type === "error") outcome.errors.push(event.message);
    else if (event.type === "meta") outcome.usageByRound.set(event.round ?? 0, event.usage ?? {});
  }

  outcome.usage = [...outcome.usageByRound.values()].reduce(
    (sum, u) => ({ input: sum.input + (u.input ?? 0), output: sum.output + (u.output ?? 0) }),
    { input: 0, output: 0 }
  );
  return outcome;
}

async function judge(options, task, answer, criteria) {
  const prompt = [
    "You are grading another model's answer to a task. Be strict but fair.",
    "You do not know the current date or time and have no real-time information,",
    "so never fail an answer because its dates or times disagree with your own",
    "assumptions about today.",
    "",
    `<task>\n${task}\n</task>`,
    "",
    `<answer>\n${answer}\n</answer>`,
    "",
    `<criteria>\n${criteria}\n</criteria>`,
    "",
    "Does the answer meet the criteria?",
    "Reply with exactly PASS or FAIL on the first line, then a one-sentence reason.",
  ].join("\n");

  const outcome = await chat(options, { model: options.judgeModel, prompt, tools: false });
  if (outcome.errors.length) throw new Error(outcome.errors.join("; "));
  const [verdict, ...rest] = outcome.text.trim().split("\n");
  return { pass: /^\s*PASS\b/i.test(verdict), reason: rest.join(" ").trim() || verdict.trim() };
}

async function runCheck(check, testCase, outcome, options) {
  const text = outcome.text;
  const called = (name) => outcome.toolCalls.some((c) => c.name === name);

  switch (check.type) {
    case "contains": {
      const pass = text.toLowerCase().includes(check.value.toLowerCase());
      return { desc: `contains "${check.value}"`, pass };
    }
    case "regex": {
      const pass = new RegExp(check.value, check.flags).test(text);
      return { desc: `matches /${check.value}/${check.flags ?? ""}`, pass };
    }
    case "tool_called":
      return { desc: `called ${check.name}`, pass: called(check.name) };
    case "no_tools_called":
      return {
        desc: "called no tools",
        pass: outcome.toolCalls.length === 0,
        detail: outcome.toolCalls.map((c) => c.name).join(", ") || undefined,
      };
    case "tools_ok": {
      const failed = outcome.toolResults.filter((r) => !r.ok);
      return {
        desc: "all tool results ok",
        pass: outcome.toolResults.length > 0 && failed.length === 0,
        detail: failed.map((r) => `${r.name}: ${r.content.slice(0, 80)}`).join("; ") || undefined,
      };
    }
    case "judge": {
      await sleep(options.delay);
      try {
        const { pass, reason } = await judge(options, testCase.prompt, text, check.criteria);
        return { desc: "judge", pass, detail: reason };
      } catch (err) {
        return { desc: "judge", pass: false, detail: `judge unavailable: ${err.message}` };
      }
    }
    default:
      return { desc: check.type, pass: false, detail: "unknown check type" };
  }
}

async function runCase(testCase, model, options, runId) {
  const prompt = testCase.prompt.replaceAll("{RUNID}", runId);
  const started = Date.now();

  let outcome;
  try {
    outcome = await chat(options, { model, prompt, tools: testCase.tools });
  } catch (err) {
    return {
      id: testCase.id,
      model,
      pass: false,
      durationMs: Date.now() - started,
      checks: [{ desc: "request", pass: false, detail: String(err.message) }],
      toolCalls: [],
      usage: { input: 0, output: 0 },
      text: "",
    };
  }

  const checks = [];
  for (const check of testCase.checks) {
    checks.push(await runCheck(check, { ...testCase, prompt }, outcome, options));
  }
  // A stream error fails the case even if the checks happened to pass.
  for (const message of outcome.errors) {
    checks.push({ desc: "stream error", pass: false, detail: message.slice(0, 160) });
  }

  return {
    id: testCase.id,
    model,
    pass: checks.every((c) => c.pass),
    durationMs: Date.now() - started,
    checks,
    toolCalls: outcome.toolCalls.map((c) => c.name),
    usage: outcome.usage,
    text: outcome.text.slice(0, 500),
  };
}

function printResult(result) {
  const mark = result.pass ? "PASS" : "FAIL";
  const tokens = `${result.usage.input}in/${result.usage.output}out`;
  console.log(
    `${mark}  ${result.id.padEnd(20)} ${result.model.padEnd(24)} ${String(result.durationMs).padStart(6)}ms  ${tokens}`
  );
  for (const check of result.checks) {
    if (!check.pass) console.log(`      ✗ ${check.desc}${check.detail ? ` — ${check.detail}` : ""}`);
  }
}

async function commandRun(argv) {
  const options = parseArgs(argv);
  const runId = Date.now().toString(36);
  const cases = CASES.filter((c) => c.id.includes(options.filter));
  if (cases.length === 0) throw new Error(`No cases match "${options.filter}"`);

  console.log(`run ${runId}: ${cases.length} case(s) × ${options.models.length} model(s) via ${options.base}\n`);

  const results = [];
  for (const model of options.models) {
    for (const testCase of cases) {
      if (results.length > 0) await sleep(options.delay);
      const result = await runCase(testCase, model, options, runId);
      results.push(result);
      printResult(result);
    }
  }

  const passed = results.filter((r) => r.pass).length;
  const usage = results.reduce(
    (sum, r) => ({ input: sum.input + r.usage.input, output: sum.output + r.usage.output }),
    { input: 0, output: 0 }
  );
  console.log(`\n${passed}/${results.length} passed · ${usage.input} in / ${usage.output} out tokens`);

  const outDir = path.join(import.meta.dirname, "results");
  await fs.mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await fs.writeFile(
    outFile,
    JSON.stringify(
      { runId, date: new Date().toISOString(), options: { ...options, filter: undefined }, results },
      null,
      2
    )
  );
  console.log(`wrote ${path.relative(process.cwd(), outFile)}`);

  process.exitCode = passed === results.length ? 0 : 1;
}

async function commandCompare(oldPath, newPath) {
  const [before, after] = await Promise.all(
    [oldPath, newPath].map(async (p) => JSON.parse(await fs.readFile(p, "utf8")))
  );
  const key = (r) => `${r.id} · ${r.model}`;
  const previous = new Map(before.results.map((r) => [key(r), r]));

  let regressions = 0;
  for (const result of after.results) {
    const prior = previous.get(key(result));
    const was = prior ? (prior.pass ? "PASS" : "FAIL") : "new";
    const now = result.pass ? "PASS" : "FAIL";
    if (was === now) continue;
    if (was === "PASS" && now === "FAIL") regressions++;
    console.log(`${was} → ${now}  ${key(result)}`);
    for (const check of result.checks) {
      if (!check.pass) console.log(`      ✗ ${check.desc}${check.detail ? ` — ${check.detail}` : ""}`);
    }
  }

  const score = (run) => `${run.results.filter((r) => r.pass).length}/${run.results.length}`;
  console.log(`\n${score(before)} → ${score(after)}${regressions ? ` · ${regressions} regression(s)` : ""}`);
  process.exitCode = regressions ? 1 : 0;
}

const [command, ...rest] = process.argv.slice(2);
if (command === "compare") {
  if (rest.length !== 2) throw new Error("usage: run.mjs compare old.json new.json");
  await commandCompare(rest[0], rest[1]);
} else if (command === "run" || command === undefined) {
  await commandRun(command === "run" ? rest : []);
} else {
  throw new Error(`Unknown command: ${command}`);
}
