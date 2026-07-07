// live e2e: multi-tenant SaaS dataset evaluation — import → tenant-owned registry → load → runSuite → Scorecard store.
// The user flow as-is: import an external benchmark (WebVoyager jsonl) via @everdict/datasets → DatasetRegistry.register(tenant)
// (user-owned) → load via registry.get(tenant) → per-case evaluation with the real browser-use harness → Scorecard → ScorecardStore.
//
// Benchmark: WebVoyager (github.com/MinorJerry/WebVoyager). The full set is 15 commercial sites + VLM scoring → here an accessible subset
// (datasets/webvoyager-mini.jsonl, same format). The same importer also works on the full WebVoyager_data.jsonl (DATASET=).
//
// Prereq: chromedp CDP + LiteLLM (gpt-5.4-mini) + browser-use venv. Env: OPENAI_API_KEY, OPENAI_BASE_URL, CDP_URL, BU_PY.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";
import { importWebVoyager } from "../../packages/datasets/dist/index.js";
import { InMemoryScorecardStore } from "../../packages/db/dist/index.js";
import { makeGraders } from "../../packages/graders/dist/index.js";
import { InMemoryDatasetRegistry } from "../../packages/registry/dist/index.js";
import { runSuite, summarizeScorecard } from "../../packages/suite/dist/index.js";

const PY = process.env.BU_PY ?? "python3";
const DATASET = process.env.DATASET ?? "datasets/webvoyager-mini.jsonl";
const TENANT = process.env.TENANT ?? "acme";
const DS_ID = "webvoyager-mini";
const DS_VER = "1.0.0";
const HV = "0.13.1";

// 1) import (external format → Everdict Dataset) → register in the tenant-owned registry (the user adds it to their workspace).
const dataset = importWebVoyager(readFileSync(DATASET, "utf8"), {
  id: DS_ID,
  version: DS_VER,
  description: "WebVoyager mini",
});
const registry = new InMemoryDatasetRegistry();
await registry.register(TENANT, dataset);
console.log(`imported + registered: ${TENANT}/${DS_ID}@${DS_VER} (${dataset.cases.length} cases)`);

// 2) load from the registry (tenant-owned round-trip) → Suite.
const loaded = await registry.get(TENANT, DS_ID, DS_VER);
const suite = { id: loaded.id, harness: { id: "browser-use" }, cases: loaded.cases };
console.log(`WebVoyager eval — ${suite.cases.length} cases × real browser-use (${HV}), dataset from registry\n`);

// 3) dispatch = run one case with the real browser-use agent → CaseResult (scored by the registry case's graders).
const dispatch = async (job) => {
  const c = job.evalCase;
  let r = { final: "", steps: 0, actions: [], urls: [] };
  try {
    const out = execFileSync(PY, ["scripts/live/browser-use-agent.py"], {
      encoding: "utf8",
      env: {
        ...process.env,
        BU_TASK: `Go to ${c.env.startUrl} and answer: ${c.task}`,
        BU_MAX_STEPS: "8",
        BU_LLM_TIMEOUT: "90",
      },
    });
    const m = /BU_RESULT=(\{.*\})/.exec(out);
    if (m) r = JSON.parse(m[1]);
  } catch (e) {
    console.log(`  [${c.id}] agent error: ${(e.message ?? "").slice(0, 70)}`);
  }
  const trace = [
    ...(r.actions ?? []).map((a, i) => ({ t: i, kind: "tool_call", id: `a${i}`, name: a, args: {} })),
    { t: 999, kind: "message", role: "assistant", text: r.final ?? "" },
  ];
  const snapshot = {
    kind: "browser",
    url: (r.urls ?? []).at(-1) ?? c.env.startUrl ?? "",
    dom: r.final ?? "",
    console: [],
  };
  const scores = [];
  for (const g of makeGraders(c.graders)) scores.push(await g.grade({ case: c, trace, snapshot }));
  const am = scores.find((s) => s.graderId === "answer-match");
  console.log(
    `  [${c.id}] → ${JSON.stringify((r.final ?? "").slice(0, 45))} | answer-match:${am?.pass ? "PASS" : "fail"} steps:${r.steps}`,
  );
  return { caseId: c.id, harness: `browser-use@${HV}`, trace, snapshot, scores };
};

// 4) runSuite → Scorecard → ScorecardStore(tenant-scoped) + summarize.
const scorecard = await runSuite(suite, HV, dispatch, { concurrency: 1 });
const summary = summarizeScorecard(scorecard);
const store = new InMemoryScorecardStore();
const now = new Date().toISOString();
await store.create({
  id: `sc-${DS_ID}-${HV}`,
  tenant: TENANT,
  dataset: { id: DS_ID, version: DS_VER },
  harness: { id: "browser-use", version: HV },
  status: "succeeded",
  summary,
  scorecard,
  createdAt: now,
  updatedAt: now,
});
const stored = await store.list(TENANT);
console.log("\n=== Scorecard:", scorecard.harness, `(stored: ${stored.length} for ${TENANT}) ===`);
for (const s of summary)
  console.log(
    `  ${s.metric}: passRate=${s.passRate === undefined ? "-" : `${(s.passRate * 100).toFixed(0)}%`} mean=${s.mean.toFixed(2)} n=${s.count}`,
  );
const passRate = summary.find((s) => s.metric === "answer_match")?.passRate ?? 0;
console.log(
  `\n✅ multi-tenant dataset eval e2e: WebVoyager import → tenant-owned registry (${TENANT}) → load → real browser-use evaluation → Scorecard stored. task success (answer_match)=${(passRate * 100).toFixed(0)}%.`,
);
process.exit(0);
