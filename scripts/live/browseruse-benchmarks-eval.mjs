// Live e2e: run the browser-use harness over the three bundle benchmarks (WebVoyager 2025 /
// Online-Mind2Web / BU Bench V1 open) THROUGH the real everdict execution path — no hand-rolled
// dispatch. Every step of the evaluation is engine code; the script only assembles jobs (data) and
// resolves the tenant secret, exactly as the control plane + self-hosted runner do:
//
//   resolveHarnessInstance (template + pins → HarnessSpec)          [core, control-plane resolve]
//   resolveHarnessSecrets  (secretRef → LiteLLM key)               [core, control-plane secret bake]
//   importFromSpec         (bundle recipe → Dataset)               [datasets, POST /benchmarks/import]
//   runLeasedJob           (self-hosted runner kind-branch:        [runner-core]
//       case.image + docker → DockerDriver container runs the CommandHarness; trace:none stdout →
//       assistant message; runCase + safeGrade grade via makeGradersFromEnv judge)
//   runSuite               (batch loop → Scorecard)                [suite, ScorecardService path]
//
// It never runs docker, parses stdout, or calls a grader itself — that is the whole point: the
// evaluation is performed by everdict, not by this script.
//
// Prereqs: docker image browseruse-eval:0.13.3 (examples/bundles/browser-use/Dockerfile) + LiteLLM on :4000.
// Key: OPENAI_API_KEY env or workclaw/infra/litellm/.env(LITELLM_MASTER_KEY).
// Knobs: LIMIT (cases/benchmark, default 2), FETCH (HF rows scanned before benign filter, default 300),
//        MODEL (default gpt-5.4-mini), JUDGE_MODEL, MAX_STEPS (default 12),
//        ONLY=webvoyager-2025,online-mind2web,bu-bench-v1-open (comma list to restrict).
import { readFileSync } from "node:fs";
import process from "node:process";
import { resolveHarnessInstance, resolveHarnessSecrets } from "../../packages/core/dist/index.js";
import { BenchmarkAdapterSpecSchema, importFromSpec } from "../../packages/datasets/dist/index.js";
import { InMemoryScorecardStore } from "../../packages/db/dist/index.js";
import { runLeasedJob } from "../../packages/runner-core/dist/index.js";
import { runSuite, summarizeScorecard } from "../../packages/suite/dist/index.js";

const MODEL = process.env.MODEL ?? "gpt-5.4-mini";
const JUDGE_MODEL = process.env.JUDGE_MODEL ?? "gpt-5.4-mini";
const MAX_STEPS = process.env.MAX_STEPS ?? "12";
const LIMIT = Number(process.env.LIMIT ?? "2");
const FETCH = Number(process.env.FETCH ?? "300");
const TENANT = process.env.TENANT ?? "acme";
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
// The judge grader runs in THIS (runner) process → reach LiteLLM on the host (localhost), while the
// harness's own model call runs in the container and reaches it via the bridge gateway (172.17.0.1,
// baked into the harness env). runAgentJob builds the judge from process.env + judgeEnv(job.judge).
process.env.OPENAI_API_KEY = KEY;
process.env.OPENAI_BASE_URL = process.env.OPENAI_BASE_URL ?? "http://localhost:4000/v1";

// ── Resolve the bundle's command harness exactly as the control plane does: template + instance pins
//    → HarnessSpec, then bake the OPENAI_API_KEY secretRef (scope:user) to the LiteLLM value. ──
const bundle = JSON.parse(
  readFileSync(new URL("../../examples/bundles/browser-use/bundle.json", import.meta.url), "utf8"),
);
const template = bundle.harnessTemplates[0];
const instance = bundle.harnesses[0];
let spec = resolveHarnessInstance(template, { ...instance, pins: { ...instance.pins, model: MODEL } });
spec = resolveHarnessSecrets(spec, { user: { OPENAI_API_KEY: KEY }, workspace: {} });
spec = { ...spec, params: { ...spec.params, max_steps: MAX_STEPS } };

const recipeById = Object.fromEntries(bundle.benchmarkRecipes.map((r) => [r.id, r]));
const buText = readFileSync(
  new URL("../../examples/bundles/browser-use/bu_bench_v1_open.jsonl", import.meta.url),
  "utf8",
);

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

// Build a benign, high-signal slice of one benchmark via the real recipe → dataset path.
async function loadSlice(id) {
  const recipe = BenchmarkAdapterSpecSchema.parse(recipeById[id]);
  const meta = { id, version: recipe.version, description: recipe.description ?? id };
  if (recipe.source.kind === "jsonl") {
    const ds = await importFromSpec(recipe, meta, { text: buText });
    return ds.cases.slice(0, LIMIT);
  }
  const ds = await importFromSpec(recipe, meta, { limit: FETCH });
  const benign = ds.cases.filter(isBenign);
  const easyBenign = benign.filter((c) => (c.tags || []).includes("easy"));
  const pick = easyBenign.length >= LIMIT ? easyBenign : benign.length ? benign : ds.cases;
  return pick.slice(0, LIMIT);
}

// dispatch = the real self-hosted runner entrypoint. It sees case.image + docker → DockerDriver container,
// runs the CommandHarness inside it, and grades with runCase + safeGrade (makeGradersFromEnv judge).
const dispatch = (job) => runLeasedJob(job, { dockerAvailable: true, log: (m) => console.error(`    · ${m}`) });

const store = new InMemoryScorecardStore();
const now = new Date().toISOString();
const overall = [];
const ids = (ONLY.length ? ONLY : ["webvoyager-2025", "online-mind2web", "bu-bench-v1-open"]).filter(
  (id) => recipeById[id],
);

console.log(
  `browser-use benchmarks eval (everdict runLeasedJob path) — model=${MODEL} judge=${JUDGE_MODEL} limit=${LIMIT}/benchmark\n`,
);
for (const id of ids) {
  const cases = await loadSlice(id);
  console.log(`\n=== ${id} — ${cases.length} case(s) via real browser-use ${spec.version} ===`);
  if (!cases.length) {
    console.log("  (no cases after benign filter — skipping)");
    continue;
  }
  // AgentJob per case — harnessSpec embedded (control-plane style) + image promoted onto the case (executeCase.withHarnessImage) + judge model.
  const suite = { id, harness: { id: spec.id }, cases };
  const toJob = (job) => ({
    ...job,
    tenant: TENANT,
    harnessSpec: spec,
    judge: { model: JUDGE_MODEL, provider: "openai" },
    evalCase: { ...job.evalCase, image: job.evalCase.image ?? spec.image },
  });
  const scorecard = await runSuite(suite, spec.version, (job) => dispatch(toJob(job)), { concurrency: 1 });
  const summary = summarizeScorecard(scorecard);
  await store.create({
    id: `sc-${id}-${spec.version}`,
    tenant: TENANT,
    dataset: { id, version: recipeById[id].version },
    harness: { id: spec.id, version: spec.version },
    status: "succeeded",
    summary,
    scorecard,
    createdAt: now,
    updatedAt: now,
  });
  for (const r of scorecard.results) {
    const judge = r.scores.find((s) => s.metric === "judge");
    const ans = r.snapshot?.dom ?? r.trace?.findLast?.((e) => e.kind === "message")?.text ?? "";
    console.log(
      `    [${r.caseId}] ${judge?.pass ? "PASS" : judge?.pass === false ? "FAIL" : "?"} ${JSON.stringify((ans || "").slice(-70))}`,
    );
  }
  console.log(`  [${id}] summary:`);
  for (const s of summary) {
    const pr = s.passRate === undefined ? "-" : `${(s.passRate * 100).toFixed(0)}%`;
    console.log(`    ${s.metric}: passRate=${pr} mean=${s.mean.toFixed(2)} n=${s.count}`);
  }
  const judgePass = summary.find((s) => s.metric === "judge")?.passRate;
  overall.push({ id, n: cases.length, task: judgePass === undefined ? "-" : `${(judgePass * 100).toFixed(0)}%` });
}

console.log(`\n=== browser-use × ${overall.length} benchmarks — task success (judge passRate) ===`);
for (const o of overall) console.log(`  ${o.id.padEnd(20)} n=${o.n}  success=${o.task}`);
const stored = await store.list(TENANT);
console.log(
  `\n✅ ran ${overall.length} benchmark(s) through everdict's real execution path (runLeasedJob → CommandHarness in DockerDriver → runCase/safeGrade → runSuite) → ${stored.length} Scorecard(s) for ${TENANT}.`,
);
process.exit(0);
