// Live experiment: how RICH can one judge's metric set be, does it surface in the evaluation, and can we see its
// TREND over time? A single code judge derives ~10 diverse metrics from one evaluation pass — numeric means
// (correctness/completeness/coverage/style/composite), DERIVED metrics (efficiency from step count), and pass-rate
// booleans (error_free/token_budget/latency_ok) — each with its own computed `detail` reason, plus one LLM-authored
// qualitative metric (the agentic slot). We then run the SAME (dataset, judge) across THREE harness versions whose
// self-reported quality declines (v1 good → v2 medium → v3 poor), simulating a harness regression over time.
//
// Verifies three things end-to-end:
//   ① richness   — every metric lands in the scorecard's per-metric summary (mean + passRate), from ONE judge pass.
//   ② visibility — GET /scorecards/:id summary carries all judge:rich:<sub> metrics with correct aggregation.
//   ③ trend      — GET /scorecards/trend?metric=judge:rich:<sub> lays the 3 scorecards out in time order and flags the
//                  regression (deltaVsBaseline < 0, regressed=true); GET /scorecards/diff v1↔v3 shows per-metric deltas.
//
// No docker: a command harness with trace:none turns its stdout (a JSON quality report) into the trace's assistant
// message, which the code judge parses. Deterministic → the trend is exact. LiteLLM (:4000) powers the one LLM metric.
//
// Usage: node scripts/live/judge-rich-metrics-trend.mjs   (apps/api/dist + apps/cli/dist built).
import { execFileSync, spawn } from "node:child_process";
import process from "node:process";

const PORT = process.env.CP_PORT ?? "8814";
const BASE = `http://127.0.0.1:${PORT}`;
const H = { "content-type": "application/json", "x-everdict-tenant": "default" };
const ROOT = new URL("../..", import.meta.url).pathname;
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

let LLM_KEY = process.env.OPENAI_API_KEY;
if (!LLM_KEY) {
  try {
    LLM_KEY = sh("docker", ["exec", "infra-litellm", "sh", "-c", "echo $LITELLM_MASTER_KEY"]).trim();
  } catch {}
}
const llmOk = Boolean(LLM_KEY);

// Three declining self-reported quality reports (the "harness got worse over versions" story).
const REPORTS = {
  "1.0.0": {
    correctness: 0.95,
    completeness: 0.9,
    steps: 8,
    errors: 0,
    tokens: 1200,
    latency_ms: 2500,
    coverage: 0.85,
    style: 0.9,
    note: "Completed every subtask cleanly on the first pass.",
  },
  "2.0.0": {
    correctness: 0.75,
    completeness: 0.7,
    steps: 14,
    errors: 1,
    tokens: 2100,
    latency_ms: 4200,
    coverage: 0.65,
    style: 0.7,
    note: "Mostly done; one retry after a failed step.",
  },
  "3.0.0": {
    correctness: 0.5,
    completeness: 0.45,
    steps: 22,
    errors: 3,
    tokens: 3200,
    latency_ms: 6800,
    coverage: 0.4,
    style: 0.55,
    note: "Struggled — several failures and a truncated result.",
  },
};

// The rich judge: ONE pass over the trace → many metrics, each with a reason. Reads the JSON report the command
// harness printed (trace:none → stdout becomes the assistant message). Numeric means + derived + pass-rate booleans
// + one LLM-scored qualitative metric (agentic). Metric prefix `judge` → judge:rich, `judge:<x>` → judge:rich:<x>.
const RICH_JUDGE = `
import json, sys, os, urllib.request
ctx = json.load(open(sys.argv[1]))
trace = ctx.get("trace", [])
# the command harness (trace:none) emits its stdout as the assistant message — parse the JSON report from it.
report = {}
for e in reversed(trace):
    if e.get("kind") == "message" and e.get("role") == "assistant":
        try:
            report = json.loads(str(e.get("text", "")).strip()); break
        except Exception:
            pass
def g(k, d=0): return report.get(k, d)
correctness, completeness = float(g("correctness")), float(g("completeness"))
coverage, style = float(g("coverage")), float(g("style"))
steps, errors = int(g("steps", 99)), int(g("errors", 9))
tokens, latency = int(g("tokens", 99999)), int(g("latency_ms", 99999))
TOKEN_BUDGET, LATENCY_BUDGET = 2000, 5000
efficiency = max(0.0, 1.0 - steps / 30.0)
composite = round((correctness * 0.4 + completeness * 0.3 + coverage * 0.2 + style * 0.1), 4)
overall = round((correctness + completeness + coverage + style) / 4.0, 4)
scores = [
  # numeric metrics are mean-only (no pass) so their TREND surfaces the numeric mean; the bar lives in the reason.
  {"graderId": "judge", "metric": "judge", "value": overall,
   "detail": f"weighted quality {overall:.2f} across correctness/completeness/coverage/style — {'healthy' if overall>=0.6 else 'below bar'}"},
  {"graderId": "judge", "metric": "judge:correctness", "value": correctness,
   "detail": f"self-reported correctness {correctness:.2f} ({'meets' if correctness>=0.7 else 'misses'} the 0.70 bar)"},
  {"graderId": "judge", "metric": "judge:completeness", "value": completeness,
   "detail": f"completeness {completeness:.2f} — {int(completeness*100)}% of subtasks finished"},
  {"graderId": "judge", "metric": "judge:coverage", "value": coverage,
   "detail": f"coverage {coverage:.2f}"},
  {"graderId": "judge", "metric": "judge:style", "value": style,
   "detail": f"style score {style:.2f}"},
  {"graderId": "judge", "metric": "judge:efficiency", "value": round(efficiency, 4),
   "detail": f"efficiency {efficiency:.2f} derived from {steps} steps (fewer is better, /30 cap)"},
  {"graderId": "judge", "metric": "judge:composite", "value": composite,
   "detail": f"composite 0.4*corr+0.3*compl+0.2*cov+0.1*style = {composite:.3f}"},
  {"graderId": "judge", "metric": "judge:error_free", "value": 1 if errors == 0 else 0, "pass": errors == 0,
   "detail": f"reason: {errors} error event(s) reported ({'clean' if errors==0 else 'not error-free'})"},
  {"graderId": "judge", "metric": "judge:token_budget", "value": 1 if tokens <= TOKEN_BUDGET else 0, "pass": tokens <= TOKEN_BUDGET,
   "detail": f"reason: used {tokens} tokens vs {TOKEN_BUDGET} budget ({'within' if tokens<=TOKEN_BUDGET else 'over'})"},
  {"graderId": "judge", "metric": "judge:latency_ok", "value": 1 if latency <= LATENCY_BUDGET else 0, "pass": latency <= LATENCY_BUDGET,
   "detail": f"reason: {latency}ms vs {LATENCY_BUDGET}ms budget ({'ok' if latency<=LATENCY_BUDGET else 'too slow'})"},
]
# agentic slot — an LLM rates the narrative quality of the report's note, with its own authored reason.
model = os.environ.get("EVERDICT_JUDGE_MODEL", ""); base = os.environ.get("OPENAI_BASE_URL", ""); key = os.environ.get("OPENAI_API_KEY", "")
if model and base and key:
    try:
        prompt = "Rate 0..1 how professional and specific this agent run note is, and why. Note: " + json.dumps(g("note", "")) + '\\nReply ONLY compact JSON: {"score":0..1,"reason":"one sentence"}.'
        body = json.dumps({"model": model, "messages": [{"role": "user", "content": prompt}], "temperature": 0}).encode()
        req = urllib.request.Request(base.rstrip("/") + "/v1/chat/completions", data=body, headers={"content-type": "application/json", "authorization": "Bearer " + key})
        resp = json.load(urllib.request.urlopen(req, timeout=60))
        c = resp["choices"][0]["message"]["content"]; v = json.loads(c[c.find("{"): c.rfind("}")+1])
        scores.append({"graderId": "judge", "metric": "judge:narrative", "value": float(v.get("score", 0)), "detail": "LLM: " + str(v.get("reason", ""))[:160]})
    except Exception as ex:
        scores.append({"graderId": "judge", "metric": "judge:narrative", "value": 0, "detail": "narrative judge error: " + str(ex)[:120]})
print(json.dumps(scores))
`.trim();

// The deterministic sub-metrics whose trend we assert (exclude the LLM one — nondeterministic).
const NUMERIC_METRICS = [
  "judge:rich",
  "judge:rich:correctness",
  "judge:rich:completeness",
  "judge:rich:coverage",
  "judge:rich:style",
  "judge:rich:efficiency",
  "judge:rich:composite",
];
const PASS_METRICS = ["judge:rich:error_free", "judge:rich:token_budget", "judge:rich:latency_ok"];
const ALL_METRICS = [...NUMERIC_METRICS, ...PASS_METRICS];

console.log(`=== ① control plane (:${PORT}) + self-hosted runner ===`);
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
  if (llmOk) {
    await put("/secrets/OPENAI_API_KEY", { value: LLM_KEY });
    await put("/secrets/OPENAI_BASE_URL", { value: LLM_BASE });
  }
  console.log(`  LLM: ${llmOk ? "on" : "off"} (${LLM_MODEL} @ ${LLM_BASE})`);

  const paired = await post("/runners", { label: "rich-metrics", capabilities: ["git"] });
  const runnerId = paired.json.runner.id;
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
      "400",
      "--max-concurrent",
      "4",
    ],
    { cwd: ROOT, env: { ...process.env }, stdio: ["ignore", "ignore", "ignore"] },
  );
  await sleep(3000);

  // rich code judge (once)
  const jr = await post("/judges", {
    kind: "code",
    id: "rich",
    version: "1",
    language: "python",
    code: RICH_JUDGE,
    ...(llmOk ? { model: LLM_MODEL, provider: "openai" } : {}),
  });
  check(jr.status < 300, `registered rich judge → ${jr.status}`);

  // dataset: 3 identical cases (per-metric count=3 in the summary)
  await post("/datasets", {
    id: "rich-ds",
    version: "1.0.0",
    cases: [0, 1, 2].map((c) => ({
      id: `rc-${c}`,
      env: { kind: "repo", source: { files: {} } },
      task: "emit a quality report",
      graders: [{ id: "tests-pass", config: { cmd: "true" } }],
      timeoutSec: 60,
      tags: ["rich"],
    })),
  });

  // three harness versions with declining reports (same harness id → one trend series)
  console.log("\n=== ② register 3 declining harness versions ===");
  for (const v of ["1.0.0", "2.0.0", "3.0.0"]) {
    const report = JSON.stringify(REPORTS[v]).replace(/'/g, ""); // no single quotes → safe inside echo '...'
    await post("/harness-templates", {
      kind: "command",
      category: "cli-agent",
      id: `rich-tpl-${v}`,
      version: "1",
      setup: [],
      // driver runs `sh -c "<command>"` (spawn shell:true) → single-quoted JSON survives; stdout becomes the trace's assistant message (trace:none).
      command: `echo '${report}'`,
      env: {},
      trace: { kind: "none" },
    });
    const hr = await post("/harnesses", {
      template: { id: `rich-tpl-${v}`, version: "1" },
      id: "rich-agent",
      version: v,
      pins: {},
    });
    check(
      hr.status < 300,
      `rich-agent@${v} (report: corr=${REPORTS[v].correctness}, errors=${REPORTS[v].errors}) → ${hr.status}`,
    );
  }

  // run one scorecard per version, in order (createdAt ascending → trend order)
  console.log("\n=== ③ run 3 scorecards (v1 → v2 → v3) ===");
  const scByVersion = {};
  for (const v of ["1.0.0", "2.0.0", "3.0.0"]) {
    const sub = await post("/scorecards", {
      dataset: { id: "rich-ds", version: "1.0.0" },
      harness: { id: "rich-agent", version: v },
      runtime: `self:${runnerId}`,
      concurrency: 3,
      judges: [{ id: "rich", version: "1" }],
    });
    if (!sub.json.id) throw new Error(`submit ${v} failed: ${JSON.stringify(sub.json)}`);
    let rec;
    for (let i = 0; i < 120; i++) {
      await sleep(1500);
      rec = await get(`/scorecards/${sub.json.id}`);
      if (rec.status === "succeeded" || rec.status === "failed") break;
    }
    scByVersion[v] = sub.json.id;
    // per-case diagnostic — trace length + parsed coverage per case (root-causes any "1 of 3 got 0" dilution)
    const cases = rec.scorecard?.results ?? [];
    const perCase = cases
      .map((c) => {
        const cov = (c.scores ?? []).find((s) => s.metric === "judge:rich:coverage");
        return `${c.caseId}[trace=${(c.trace ?? []).length},cov=${cov ? cov.value : "MISSING"}]`;
      })
      .join(" ");
    console.log(`  rich-agent@${v} → ${rec.status} (${sub.json.id})  cases: ${perCase}`);
    if (rec.status !== "succeeded") throw new Error(`scorecard ${v} did not succeed: ${rec.status}`);
    await sleep(1100); // ensure a distinct createdAt ordering between successive scorecards
  }

  // ── ① + ② richness + visibility: every metric in each scorecard's summary ──
  console.log("\n=== ④ richness + visibility: one judge → many metrics in the summary ===");
  const summaries = {};
  for (const v of ["1.0.0", "2.0.0", "3.0.0"]) {
    const rec = await get(`/scorecards/${scByVersion[v]}`);
    const summary = rec.scorecard?.summary ?? rec.summary ?? [];
    summaries[v] = new Map(summary.map((s) => [s.metric, s]));
  }
  const v1 = summaries["1.0.0"];
  check(
    ALL_METRICS.every((m) => v1.has(m)),
    `all ${ALL_METRICS.length} deterministic metrics present in v1 summary (from ONE judge)`,
  );
  check(
    NUMERIC_METRICS.every((m) => typeof v1.get(m)?.mean === "number"),
    "numeric metrics carry a mean aggregate",
  );
  check(
    PASS_METRICS.every((m) => typeof v1.get(m)?.passRate === "number"),
    "pass-rate metrics carry a passRate aggregate",
  );
  check((v1.get("judge:rich")?.count ?? 0) === 3, "per-metric aggregation counts all 3 cases (count=3)");
  if (llmOk) check(v1.has("judge:rich:narrative"), "LLM-scored agentic metric (judge:rich:narrative) present");
  console.log(`  v1 metrics: ${[...v1.keys()].filter((m) => m.startsWith("judge")).join(", ")}`);

  // ── ③ trend: the metric moves across the 3 versions, regression flagged ──
  console.log("\n=== ⑤ trend / 추이 — GET /scorecards/trend per metric ===");
  const trendOf = async (metric) =>
    get(`/scorecards/trend?dataset=rich-ds&harness=rich-agent&metric=${encodeURIComponent(metric)}&baseline=first`);
  const approx = (a, b) => a !== null && a !== undefined && Math.abs(a - b) < 0.02; // float-tolerant (mean = sum/count)
  const seq = (xs, ...expected) => xs.length === expected.length && expected.every((e, i) => approx(xs[i], e));

  const corr = await trendOf("judge:rich:correctness");
  check((corr.points ?? []).length === 3, `correctness trend has 3 time-ordered points (${corr.points?.length})`);
  const corrScores = (corr.points ?? []).map((p) => p.score);
  check(
    seq(corrScores, 0.95, 0.75, 0.5),
    `correctness mean declines 0.95 → 0.75 → 0.50 (${corrScores.map((s) => s?.toFixed(3)).join(" → ")})`,
  );
  check(
    corr.points?.[1]?.regressed === true && corr.points?.[2]?.regressed === true,
    "correctness v2 + v3 flagged as regressed vs baseline",
  );
  check(
    (corr.points?.[2]?.deltaVsBaseline ?? 0) < -0.4,
    `v3 correctness deltaVsBaseline ≈ -0.45 (${corr.points?.[2]?.deltaVsBaseline?.toFixed(3)})`,
  );

  const ef = await trendOf("judge:rich:error_free");
  const efRates = (ef.points ?? []).map((p) => p.passRate);
  check(seq(efRates, 1, 0, 0), `error_free passRate drops 1 → 0 → 0 (${efRates.join(" → ")})`);
  check(ef.points?.[1]?.regressed === true, "error_free regression caught at v2");

  const lat = await trendOf("judge:rich:latency_ok");
  const latRates = (lat.points ?? []).map((p) => p.passRate);
  check(seq(latRates, 1, 1, 0), `latency_ok passRate 1 → 1 → 0 (regresses only at v3) (${latRates.join(" → ")})`);
  check(
    lat.points?.[1]?.regressed === false && lat.points?.[2]?.regressed === true,
    "latency_ok stable at v2, regresses at v3 (per-metric independence)",
  );

  const comp = await trendOf("judge:rich:composite");
  const compScores = (comp.points ?? []).map((p) => p.score);
  check(
    compScores[0] > compScores[1] && compScores[1] > compScores[2],
    `composite monotonic decline (${compScores.map((s) => s?.toFixed(3)).join(" → ")})`,
  );

  // ── diff: baseline v1 ↔ candidate v3 shows per-metric deltas ──
  console.log("\n=== ⑥ diff — v1 (baseline) ↔ v3 (candidate) per-metric deltas ===");
  const diff = await get(`/scorecards/diff?baseline=${scByVersion["1.0.0"]}&candidate=${scByVersion["3.0.0"]}`);
  const diffMetrics = new Map((diff.metrics ?? []).map((m) => [m.metric, m]));
  check(
    (diff.metrics ?? []).length >= ALL_METRICS.length,
    `diff reports ≥${ALL_METRICS.length} metrics (${diff.metrics?.length})`,
  );
  check(
    (diffMetrics.get("judge:rich:correctness")?.delta ?? 0) < 0,
    `correctness delta negative in v1↔v3 diff (${diffMetrics.get("judge:rich:correctness")?.delta?.toFixed(3)})`,
  );
  check(
    NUMERIC_METRICS.filter((m) => (diffMetrics.get(m)?.delta ?? 0) < 0).length >= 5,
    "≥5 numeric metrics regressed in the diff (broad drift, not one-off)",
  );

  // visual trend table for the log
  console.log("\n  ── metric trend across versions (mean/passRate) ──");
  console.log("  metric                     v1      v2      v3");
  for (const m of ALL_METRICS) {
    const cells = ["1.0.0", "2.0.0", "3.0.0"].map((v) => {
      const s = summaries[v].get(m);
      const val = s?.passRate ?? s?.mean;
      return (val ?? 0).toFixed(2).padStart(6);
    });
    console.log(`  ${m.replace("judge:rich", "").padEnd(24) || "(overall)".padEnd(24)} ${cells.join("  ")}`);
  }

  ok = failures.length === 0;
  console.log(
    ok
      ? "\n✅ PASS — one judge derived 10+ diverse metrics (means · derived · pass-rates · reasons + an LLM metric), all surfaced in the summary, and their trend across 3 versions showed the regression per-metric (deltaVsBaseline/regressed) + a v1↔v3 diff."
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
}
process.exit(ok ? 0 : 1);
