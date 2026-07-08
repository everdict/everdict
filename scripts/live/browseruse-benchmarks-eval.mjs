// Live e2e: run the browser-use harness over the THREE benchmark recipes shipped in
// examples/bundles/browser-use (WebVoyager 2025 / Online-Mind2Web / BU Bench V1 open) — the three
// benchmark sets browser-use actually implements + reports on. Real path, no mocks:
//   bundle recipe → @everdict/datasets importFromSpec → Dataset (real schema)
//   → dispatch = real browser-use agent in the bundle's docker image (browseruse-eval:0.13.3, run_bu.py)
//   → @everdict/graders makeGradersFromEnv (judge over final answer via LiteLLM + steps + text-metric)
//   → @everdict/suite runSuite → per-benchmark Scorecard → summarizeScorecard.
//
// Prereqs: docker image browseruse-eval:0.13.3 (build examples/bundles/browser-use/Dockerfile) +
//          LiteLLM proxy on :4000. Key: OPENAI_API_KEY env or workclaw/infra/litellm/.env(LITELLM_MASTER_KEY).
// Knobs: LIMIT (cases per benchmark, default 2), FETCH (HF rows scanned before benign filter, default 300),
//        MODEL (default gpt-5.4-mini), JUDGE_MODEL, MAX_STEPS (default 12),
//        ONLY=webvoyager-2025,online-mind2web,bu-bench-v1-open (comma list to restrict).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";
import { BenchmarkAdapterSpecSchema, importFromSpec } from "../../packages/datasets/dist/index.js";
import { InMemoryScorecardStore } from "../../packages/db/dist/index.js";
import { makeGradersFromEnv } from "../../packages/graders/dist/index.js";
import { runSuite, summarizeScorecard } from "../../packages/suite/dist/index.js";

const IMAGE = process.env.BROWSERUSE_IMAGE ?? "browseruse-eval:0.13.3";
const MODEL = process.env.MODEL ?? "gpt-5.4-mini";
const JUDGE_MODEL = process.env.JUDGE_MODEL ?? "gpt-5.4-mini";
const MAX_STEPS = process.env.MAX_STEPS ?? "12";
const LIMIT = Number(process.env.LIMIT ?? "2");
const FETCH = Number(process.env.FETCH ?? "300"); // HF rows to scan before benign-filtering (WV2025 is commercial-heavy — scan wide to find benign sites)
const HV = "0.13.3";
const TENANT = process.env.TENANT ?? "acme";
const BASE_URL = process.env.OPENAI_BASE_URL ?? "http://localhost:4000/v1";
const ONLY = (process.env.ONLY ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function masterKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  for (const p of ["../../../../infra/litellm/.env", "../../../infra/litellm/.env"]) {
    try {
      const t = readFileSync(new URL(p, import.meta.url), "utf8");
      const k = (t.match(/^LITELLM_MASTER_KEY=(.+)$/m) || [])[1]?.trim();
      if (k) return k;
    } catch {}
  }
  return undefined;
}
const KEY = masterKey();
if (!KEY) {
  console.error("No LLM key (OPENAI_API_KEY or workclaw/infra/litellm/.env).");
  process.exit(2);
}
// Wire the everdict judge grader to LiteLLM (makeGradersFromEnv → judgeFromEnv reads these).
process.env.EVERDICT_JUDGE_MODEL = JUDGE_MODEL;
process.env.EVERDICT_JUDGE_PROVIDER = "openai";
process.env.OPENAI_API_KEY = KEY;
process.env.OPENAI_BASE_URL = BASE_URL;

// Bot-friendly, info-seeking hosts — keep the slice about agent capability, not anti-bot walls.
const BENIGN = [
  "en.wikipedia.org",
  "wikipedia.org",
  "arxiv.org",
  "github.com",
  "developer.mozilla.org",
  "wolframalpha.com",
  "dictionary.cambridge.org",
  "coursera.org",
  "bbc.co",
  "espn.com",
  "huggingface.co",
];
const isBenign = (c) => BENIGN.some((h) => (c.task || "").toLowerCase().includes(h));

const bundle = JSON.parse(
  readFileSync(new URL("../../examples/bundles/browser-use/bundle.json", import.meta.url), "utf8"),
);
const recipeById = Object.fromEntries(bundle.benchmarkRecipes.map((r) => [r.id, r]));
const buText = readFileSync(
  new URL("../../examples/bundles/browser-use/bu_bench_v1_open.jsonl", import.meta.url),
  "utf8",
);

// Build one benchmark's slice via the real recipe→dataset path, biased to a benign, high-signal slice.
async function loadSlice(id) {
  const spec = BenchmarkAdapterSpecSchema.parse(recipeById[id]);
  const meta = { id, version: spec.version, description: spec.description ?? id };
  if (spec.source.kind === "jsonl") {
    const ds = await importFromSpec(spec, meta, { text: buText });
    return ds.cases.slice(0, LIMIT);
  }
  const ds = await importFromSpec(spec, meta, { limit: FETCH });
  const benign = ds.cases.filter(isBenign);
  const easyBenign = benign.filter((c) => (c.tags || []).includes("easy"));
  const pick = easyBenign.length >= LIMIT ? easyBenign : benign.length ? benign : ds.cases;
  return pick.slice(0, LIMIT);
}

// dispatch = run the real browser-use agent in the bundle's image; never throws (docker/parse errors → empty result → judge FAIL).
async function dispatch(job) {
  const c = job.evalCase;
  let final = "";
  let steps = 0;
  let err;
  try {
    const out = execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        "host",
        "-e",
        `OPENAI_API_BASE=${BASE_URL}`,
        "-e",
        `OPENAI_API_KEY=${KEY}`,
        "-e",
        "BU_USE_VISION=false",
        IMAGE,
        "python",
        "/app/run_bu.py",
        c.task,
        "--model",
        MODEL,
        "--max-steps",
        MAX_STEPS,
      ],
      {
        encoding: "utf8",
        timeout: (Number(MAX_STEPS) * 25 + 90) * 1000,
        maxBuffer: 32 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const block = out.split("=== BROWSER_USE_RESULT ===")[1]?.split("=== END_RESULT ===")[0] ?? out;
    steps = Number((/^steps: (\d+)/m.exec(block) || [])[1] ?? 0);
    const fm = /final_result: ([\s\S]*?)\n(?:steps:|self_reported_success:|$)/.exec(block);
    final = (fm ? fm[1] : "").trim();
    if (final === "(none)") final = "";
  } catch (e) {
    err = (e.stderr?.toString?.() || e.message || String(e)).slice(-200);
  }
  const text = `final_result: ${final || "(none)"}\nsteps: ${steps}`;
  const trace = [
    ...Array.from({ length: steps }, (_, i) => ({
      t: i,
      kind: "tool_call",
      id: `s${i}`,
      name: "browser_step",
      args: {},
    })),
    { t: 999, kind: "message", role: "assistant", text },
  ];
  const snapshot = { kind: "browser", url: "", dom: final, console: [] };
  const scores = [];
  for (const g of makeGradersFromEnv(c.graders)) scores.push(await g.grade({ case: c, trace, snapshot }));
  const judge = scores.find((s) => s.graderId === "judge" || s.metric === "judge");
  console.log(
    `    [${c.id}] ${judge?.pass ? "PASS" : "FAIL"} steps=${steps} final=${JSON.stringify((final || err || "").slice(0, 60))}`,
  );
  return { caseId: c.id, harness: `browser-use@${HV}`, trace, snapshot, scores };
}

const store = new InMemoryScorecardStore();
const now = new Date().toISOString();
const overall = [];
const ids = (ONLY.length ? ONLY : ["webvoyager-2025", "online-mind2web", "bu-bench-v1-open"]).filter(
  (id) => recipeById[id],
);

console.log(
  `browser-use benchmarks eval — model=${MODEL} judge=${JUDGE_MODEL} limit=${LIMIT}/benchmark image=${IMAGE}\n`,
);
for (const id of ids) {
  const cases = await loadSlice(id);
  console.log(`\n=== ${id} — ${cases.length} case(s) (real browser-use ${HV}) ===`);
  if (!cases.length) {
    console.log("  (no cases after benign filter — skipping)");
    continue;
  }
  const suite = { id, harness: { id: "browser-use" }, cases };
  const scorecard = await runSuite(suite, HV, dispatch, { concurrency: 1 });
  const summary = summarizeScorecard(scorecard);
  await store.create({
    id: `sc-${id}-${HV}`,
    tenant: TENANT,
    dataset: { id, version: recipeById[id].version },
    harness: { id: "browser-use", version: HV },
    status: "succeeded",
    summary,
    scorecard,
    createdAt: now,
    updatedAt: now,
  });
  console.log(`  [${id}] summary:`);
  for (const s of summary) {
    const pr = s.passRate === undefined ? "-" : `${(s.passRate * 100).toFixed(0)}%`;
    console.log(`    ${s.metric}: passRate=${pr} mean=${s.mean.toFixed(2)} n=${s.count}`);
  }
  const judgePass = summary.find((s) => s.metric === "judge")?.passRate;
  overall.push({ id, n: cases.length, task: judgePass === undefined ? "-" : `${(judgePass * 100).toFixed(0)}%` });
}

console.log(`\n=== browser-use × 3 benchmarks — task success (judge passRate) ===`);
for (const o of overall) console.log(`  ${o.id.padEnd(20)} n=${o.n}  success=${o.task}`);
const stored = await store.list(TENANT);
console.log(
  `\n✅ ran ${overall.length} benchmark(s) through the real browser-use harness → ${stored.length} Scorecard(s) stored for ${TENANT}.`,
);
process.exit(0);
