// Live judge torture: the FULL judge spectrum on real topology traces, verified end-to-end + under load.
// Beyond a simple pass/fail judge — code judges (python + node), multi-metric derivation WITH per-metric
// reasons, a multi-PHASE workflow judge, an AGENTIC code judge (code that calls the injected LLM to reason),
// and a multi-CRITERIA model judge — all applied to one scorecard, then re-run with trials for concurrency.
//
// Judges (registered on the workspace, applied to the sse-relay-bench topology's inline trace):
//   J1 code(python)  — multi-metric + reasons: derives step_count / tool_diversity / completeness, each a
//                      separate Score with a computed `detail` reason (judge:j1 + judge:j1:<sub>).
//   J2 code(node)     — multi-PHASE workflow: phase1 parse trace → phase2 per-kind tally → phase3 aggregate
//                      into 3 metrics with reasons. Proves a staged code judge, not a one-liner.
//   J3 code(python)   — AGENTIC: builds a prompt from the trace, CALLS the injected LLM
//                      (EVERDICT_JUDGE_MODEL + OPENAI env), parses its verdict into a metric + LLM-authored
//                      reason. Code + model in one judge (the richest "agentic" shape).
//   J4 model          — multi-CRITERIA: criteria[] (correctness, thoroughness) → one LLM call scores each
//                      (judge:j4:correctness / judge:j4:thoroughness) + the weighted overall (judge:j4).
//
// Verifies per case: every judge produced its metrics, every metric carries a reason (detail), code judges
// were sandbox-DISPATCHED (co-located on the runner), the agentic/model judges got REAL LLM verdicts, and the
// multi-metric Score[] flattened correctly. Then a trials=2 re-run stresses the streaming judge pipeline.
//
// Usage: node scripts/live/judge-torture.mjs   (docker + dists built; LiteLLM at :4000 for J3/J4).
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const PORT = process.env.CP_PORT ?? "8813";
const BASE = `http://127.0.0.1:${PORT}`;
const H = { "content-type": "application/json", "x-everdict-tenant": "default" };
const ROOT = new URL("../..", import.meta.url).pathname;
const BUNDLE_DIR = `${ROOT}examples/bundles/sse-relay-bench`;
const NETWORK = "everdict-sse-relay-bench-1.0.0";
const LLM_BASE = process.env.OPENAI_BASE_URL ?? "http://127.0.0.1:4000";
const LLM_MODEL = process.env.JUDGE_MODEL ?? "gpt-5.4-mini";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", ...opts });
const post = async (p, b) => {
  const r = await fetch(`${BASE}${p}`, { method: "POST", headers: H, body: JSON.stringify(b) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const put = async (p, b) => {
  const r = await fetch(`${BASE}${p}`, { method: "PUT", headers: H, body: JSON.stringify(b) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const get = async (p) => (await fetch(`${BASE}${p}`, { headers: H })).json();
const failures = [];
const check = (ok, label) => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}`);
  if (!ok) failures.push(label);
};

// ── LiteLLM key (from the running container) ──────────────────────────────────
let LLM_KEY = process.env.OPENAI_API_KEY;
if (!LLM_KEY) {
  try {
    LLM_KEY = sh("docker", ["exec", "infra-litellm", "sh", "-c", "echo $LITELLM_MASTER_KEY"]).trim();
  } catch {}
}
const llmOk = Boolean(LLM_KEY);
console.log(`  LiteLLM key: ${llmOk ? "found" : "MISSING — J3/J4 will skip"} · model ${LLM_MODEL} @ ${LLM_BASE}`);

// ── code judge sources ────────────────────────────────────────────────────────
// The judge context (argv[1]) is a JSON file: { case, trace, snapshot, evidence }. Each prints Score[] JSON.
const J1_PY = `
import json, sys
ctx = json.load(open(sys.argv[1]))
trace = ctx.get("trace", [])
tool_calls = [e for e in trace if e.get("kind") == "tool_call"]
msgs = [e for e in trace if e.get("kind") == "message"]
env_actions = [e for e in trace if e.get("kind") == "env_action"]
tools = set(e.get("name") for e in tool_calls)
done = any(m.get("role") == "assistant" for m in msgs)
scores = [
  {"graderId": "judge", "metric": "judge", "value": 1 if done else 0, "pass": done,
   "detail": f"overall: {'completed' if done else 'no assistant reply'} — {len(msgs)} messages, {len(tool_calls)} tool calls"},
  {"graderId": "judge", "metric": "judge:step_count", "value": len(trace),
   "detail": f"{len(trace)} trace events ({len(msgs)} msg, {len(tool_calls)} tool, {len(env_actions)} env)"},
  {"graderId": "judge", "metric": "judge:tool_diversity", "value": len(tools),
   "detail": f"distinct tools/actions: {sorted(list(tools))[:5] or ['none']}"},
  {"graderId": "judge", "metric": "judge:completeness", "value": 1 if done else 0, "pass": done,
   "detail": f"reason: {'reached an assistant message (task closed)' if done else 'trace ended without an assistant message'}"},
]
print(json.dumps(scores))
`.trim();

const J2_NODE = `
import { readFileSync } from 'node:fs';
// node code judges run as ESM (judge.mjs) — use import, not require. argv: [0]=node [1]=judge.mjs [2]=context path.
const ctx = JSON.parse(readFileSync(process.argv[2], 'utf8'));
// phase 1 — parse
const trace = ctx.trace || [];
// phase 2 — per-kind tally
const byKind = {};
for (const e of trace) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
// phase 3 — aggregate into metrics, each with a reason
const msgs = byKind.message || 0;
const errors = byKind.error || 0;
const clean = errors === 0;
const scores = [
  { graderId: 'judge', metric: 'judge', value: clean ? 1 : 0, pass: clean,
    detail: 'phase3: ' + (clean ? 'no error events across the trace' : errors + ' error event(s) present') },
  { graderId: 'judge', metric: 'judge:event_kinds', value: Object.keys(byKind).length,
    detail: 'phase2 tally: ' + JSON.stringify(byKind) },
  { graderId: 'judge', metric: 'judge:message_flow', value: msgs,
    detail: 'phase1 parse: ' + msgs + ' message events in the transcript' },
  { graderId: 'judge', metric: 'judge:error_free', value: clean ? 1 : 0, pass: clean,
    detail: clean ? 'reason: zero error events' : 'reason: ' + errors + ' error events' },
];
console.log(JSON.stringify(scores));
`.trim();

// Agentic code judge — builds a prompt from the trace, calls the injected LLM, parses a metric + reason.
const J3_PY = `
import json, sys, os, urllib.request
ctx = json.load(open(sys.argv[1]))
trace = ctx.get("trace", [])
task = ctx.get("case", {}).get("task", "")
snippet = "\\n".join(f"- {e.get('kind')}: {str(e.get('text') or e.get('action') or e.get('name') or '')[:80]}" for e in trace[:20])
model = os.environ.get("EVERDICT_JUDGE_MODEL", "")
base = os.environ.get("OPENAI_BASE_URL", "")
key = os.environ.get("OPENAI_API_KEY", "")
def emit(scores): print(json.dumps(scores))
if not (model and base and key):
  emit([{ "graderId": "judge", "metric": "judge", "value": 0, "pass": False, "detail": "skip: judge model/env not injected (EVERDICT_JUDGE_MODEL/OPENAI_*)" }]); sys.exit(0)
prompt = f"You are grading an agent run. Task: {task}\\nTrace (first events):\\n{snippet}\\nReply with ONLY compact JSON: {{\\"score\\": 0..1, \\"reason\\": \\"one sentence\\"}}."
body = json.dumps({"model": model, "messages": [{"role": "user", "content": prompt}], "temperature": 0}).encode()
req = urllib.request.Request(base.rstrip("/") + "/v1/chat/completions", data=body,
  headers={"content-type": "application/json", "authorization": "Bearer " + key})
try:
  resp = json.load(urllib.request.urlopen(req, timeout=60))
  content = resp["choices"][0]["message"]["content"]
  s = content[content.find("{"): content.rfind("}") + 1]
  verdict = json.loads(s)
  score = float(verdict.get("score", 0)); reason = str(verdict.get("reason", ""))[:200]
  emit([{ "graderId": "judge", "metric": "judge", "value": score, "pass": score >= 0.5, "detail": "LLM verdict: " + reason }])
except Exception as ex:
  emit([{ "graderId": "judge", "metric": "judge", "value": 0, "pass": False, "detail": "agentic judge error: " + str(ex)[:150] }])
`.trim();

console.log("=== ⓪ images + clean ===");
for (const [tag, ctxArg] of [
  ["sse-relay-command:v1", ["command-server"]],
  ["sse-relay-relay:v1", ["relay-server"]],
  ["sse-relay-client-host:v1", ["-f", "client-host/Dockerfile", "."]],
]) {
  try {
    sh("docker", ["image", "inspect", tag], { stdio: "ignore" });
    console.log(`  reusing ${tag}`);
  } catch {
    sh(
      "docker",
      [
        "build",
        "-q",
        "-t",
        tag,
        ...ctxArg.map((a) =>
          a === "." || a.startsWith("client") ? `${BUNDLE_DIR}` : a === "-f" ? a : `${BUNDLE_DIR}/${a}`,
        ),
      ],
      { stdio: "inherit", cwd: ROOT },
    );
  }
}
const leftover = sh("docker", ["ps", "-aq", "--filter", `name=${NETWORK}`]).trim();
if (leftover) sh("docker", ["rm", "-f", ...leftover.split("\n")], { stdio: "ignore" });
try {
  sh("docker", ["network", "rm", NETWORK], { stdio: "ignore" });
} catch {}

console.log(`\n=== ① control plane (:${PORT}) + self-hosted runner ===`);
const cp = spawn("node", ["apps/api/dist/main.js"], {
  cwd: ROOT,
  env: { ...process.env, PORT, EVERDICT_REQUIRE_AUTH: "", KEYCLOAK_ISSUER: "", DATABASE_URL: "" },
  stdio: ["ignore", "ignore", "pipe"],
});
cp.stderr.on("data", (d) => {
  const s = String(d);
  if (/error|unhandled/i.test(s)) process.stderr.write(`  [cp] ${s}`);
});
let runner;
let ok = false;
try {
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await sleep(1000);
    try {
      up = (await fetch(`${BASE}/datasets`, { headers: H })).status === 200;
    } catch {}
  }
  if (!up) throw new Error("control plane failed to start");

  // Shared secrets for the LLM-backed judges (J3 agentic-code, J4 model).
  if (llmOk) {
    await put("/secrets/OPENAI_API_KEY", { value: LLM_KEY });
    await put("/secrets/OPENAI_BASE_URL", { value: LLM_BASE });
  }

  const paired = await post("/runners", { label: "judge-runner", capabilities: ["git"] });
  runner = spawn(
    "node",
    [
      "apps/cli/dist/main.js",
      "runner",
      "--pair",
      paired.json.token,
      "--api-url",
      BASE,
      "--poll-interval-ms",
      "500",
      "--ready-timeout-ms",
      "180000",
    ],
    { cwd: ROOT, env: { ...process.env }, stdio: ["ignore", "ignore", "ignore"] },
  );
  const runnerId = paired.json.runner.id;
  await sleep(3000);

  const applied = await post("/bundles/apply", JSON.parse(readFileSync(`${BUNDLE_DIR}/bundle.json`, "utf8")));
  if ((applied.json.results ?? []).some((r) => r.status === "failed")) throw new Error("bundle apply failed");

  // ── register the 4 judges ─────────────────────────────────────────────────
  console.log("\n=== ② register judges ===");
  const reg = async (spec) => {
    const r = await post("/judges", spec);
    check(
      r.status < 300,
      `registered ${spec.id} (${spec.kind}${spec.language ? `/${spec.language}` : ""}) → ${r.status}`,
    );
  };
  await reg({ kind: "code", id: "j1", version: "1", language: "python", code: J1_PY });
  await reg({ kind: "code", id: "j2", version: "1", language: "node", code: J2_NODE });
  const judges = [
    { id: "j1", version: "1" },
    { id: "j2", version: "1" },
  ];
  if (llmOk) {
    await reg({
      kind: "code",
      id: "j3",
      version: "1",
      language: "python",
      code: J3_PY,
      model: LLM_MODEL,
      provider: "openai",
    });
    await reg({
      kind: "model",
      id: "j4",
      version: "1",
      model: LLM_MODEL,
      provider: "openai",
      rubric: "Grade whether the agent completed the streaming task correctly and thoroughly.",
      criteria: [
        { id: "correctness", description: "Did the transcript reach a correct completion (ok/done)?", weight: 1 },
        {
          id: "thoroughness",
          description: "Did the agent process a full message stream, not a partial one?",
          weight: 1,
        },
      ],
    });
    judges.push({ id: "j3", version: "1" }, { id: "j4", version: "1" });
  }

  // ── run one scorecard applying all judges, warm topology first ─────────────
  console.log("\n=== ③ scorecard with all judges (8 topology cases) ===");
  const submit = await post("/scorecards", {
    dataset: { id: "sse-relay-parallel", version: "1.0.0" },
    harness: { id: "sse-relay-bench" },
    runtime: `self:${runnerId}`,
    concurrency: 4,
    judges,
  });
  if (!submit.json.id) throw new Error(`submit failed: ${JSON.stringify(submit.json)}`);
  let rec;
  for (let i = 0; i < 300; i++) {
    await sleep(2000);
    rec = await get(`/scorecards/${submit.json.id}`);
    process.stdout.write(`  status=${rec.status} settled=${rec.scorecard?.results?.length ?? 0}/8  \r`);
    if (rec.status === "succeeded" || rec.status === "failed") break;
  }
  console.log(`\n  final=${rec.status}`);

  // ── verify per-judge metrics + reasons ─────────────────────────────────────
  console.log("\n=== ④ verify judge outputs ===");
  const results = rec.scorecard?.results ?? [];
  check(results.length === 8, `8 case results (${results.length})`);
  const anyCase = results[0];
  const metricsOf = (r) => (r.scores ?? []).map((s) => s.metric);
  const scoreFor = (r, metric) => (r.scores ?? []).find((s) => s.metric === metric);

  // J1 python multi-metric + reasons
  for (const sub of ["judge:j1", "judge:j1:step_count", "judge:j1:tool_diversity", "judge:j1:completeness"]) {
    const present = results.every((r) => scoreFor(r, sub) !== undefined);
    check(present, `J1: every case has ${sub}`);
  }
  check(
    results.every((r) => (scoreFor(r, "judge:j1:step_count")?.value ?? 0) > 0),
    "J1: step_count derived a real count from the trace",
  );
  check(
    results.every((r) => String(scoreFor(r, "judge:j1")?.detail ?? "").length > 5),
    "J1: overall carries a reason",
  );
  check(
    results.every((r) => String(scoreFor(r, "judge:j1:tool_diversity")?.detail ?? "").includes("tools")),
    "J1: tool_diversity reason present",
  );

  // J2 node multi-phase
  for (const sub of ["judge:j2", "judge:j2:event_kinds", "judge:j2:message_flow", "judge:j2:error_free"]) {
    check(
      results.every((r) => scoreFor(r, sub) !== undefined),
      `J2: every case has ${sub}`,
    );
  }
  check(
    results.every((r) => String(scoreFor(r, "judge:j2:event_kinds")?.detail ?? "").includes("phase2")),
    "J2: phase-tally reason present",
  );
  check(
    results.every((r) => (scoreFor(r, "judge:j2:message_flow")?.value ?? 0) > 0),
    "J2: message_flow counted the transcript",
  );

  if (llmOk) {
    // J3 agentic code — LLM verdict + reason
    check(
      results.every((r) => scoreFor(r, "judge:j3") !== undefined),
      "J3: every case has judge:j3",
    );
    const j3reasons = results.map((r) => String(scoreFor(r, "judge:j3")?.detail ?? ""));
    check(
      j3reasons.every((d) => d.includes("LLM verdict") || d.includes("skip")),
      "J3: agentic reason is an LLM verdict (or explicit skip)",
    );
    check(
      j3reasons.some((d) => d.includes("LLM verdict")),
      "J3: at least one real LLM verdict landed",
    );
    // J4 model multi-criteria
    for (const sub of ["judge:j4", "judge:j4:correctness", "judge:j4:thoroughness"]) {
      check(
        results.every((r) => scoreFor(r, sub) !== undefined),
        `J4: every case has ${sub}`,
      );
    }
    check(
      results.every((r) => String(scoreFor(r, "judge:j4")?.detail ?? "").length > 3),
      "J4: model overall carries a reason",
    );
  }
  console.log(
    `  sample case metrics: ${metricsOf(anyCase)
      .filter((m) => m.startsWith("judge"))
      .join(", ")}`,
  );

  // ── load: trials=2 stresses the streaming judge pipeline ───────────────────
  console.log("\n=== ⑤ load — trials=2 (16 judged runs, streaming pipeline) ===");
  const loadSub = await post("/scorecards", {
    dataset: { id: "sse-relay-parallel", version: "1.0.0" },
    harness: { id: "sse-relay-bench" },
    runtime: `self:${runnerId}`,
    concurrency: 8,
    trials: 2,
    judges,
  });
  let loadRec;
  for (let i = 0; i < 360; i++) {
    await sleep(2000);
    loadRec = await get(`/scorecards/${loadSub.json.id}`);
    if (loadRec.status === "succeeded" || loadRec.status === "failed") break;
  }
  const loadResults = loadRec.scorecard?.results ?? [];
  check(loadRec.status === "succeeded", `load scorecard succeeded (${loadRec.status})`);
  check(loadResults.length === 16, `16 judged runs (8 cases × 2 trials) (${loadResults.length})`);
  check(
    loadResults.every((r) => scoreFor(r, "judge:j1") && scoreFor(r, "judge:j2")),
    "load: every trial got the full judge set (no judge lost under concurrency)",
  );

  ok = failures.length === 0;
  console.log(
    ok
      ? "\n✅ PASS — code (py/node), multi-metric+reasons, multi-phase, agentic-code+LLM, and multi-criteria model judges all scored real traces and held under load."
      : `\n❌ FAIL — ${failures.length} check(s):\n${failures.map((f) => `   · ${f}`).join("\n")}`,
  );
} catch (e) {
  console.error("error:", e instanceof Error ? (e.stack ?? e.message) : e);
} finally {
  try {
    runner?.kill("SIGKILL");
  } catch {}
  try {
    cp.kill("SIGKILL");
  } catch {}
  if (!process.env.KEEP) {
    try {
      const names = sh("docker", ["ps", "-aq", "--filter", `name=${NETWORK}`]).trim();
      if (names) sh("docker", ["rm", "-f", ...names.split("\n")], { stdio: "ignore" });
      sh("docker", ["network", "rm", NETWORK], { stdio: "ignore" });
    } catch {}
  }
}
process.exit(ok ? 0 : 1);
