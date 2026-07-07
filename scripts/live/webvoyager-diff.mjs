// live e2e: version regression diff — evaluate the same tenant-owned dataset with two harness versions → diffScorecards.
// import → registry.register(tenant) → registry.get → runSuite(vA) + runSuite(vB) → store in ScorecardStore →
// diffScorecards(vA, vB) → regression (pass→fail)/improvement (fail→pass) report. (regression detection uses the objective `pass` transition.)
//
// Note: to make the regression reproducible, both versions' dispatch is a **deterministic stand-in** (a real LLM is nondeterministic + slow —
// unsuitable for a regression demo). The diff (scorecard comparison) is the real @everdict/suite diffScorecards. For real harness evaluation see webvoyager-eval.mjs.
import { readFileSync } from "node:fs";
import process from "node:process";
import { importWebVoyager } from "../../packages/datasets/dist/index.js";
import { InMemoryScorecardStore } from "../../packages/db/dist/index.js";
import { makeGraders } from "../../packages/graders/dist/index.js";
import { InMemoryDatasetRegistry } from "../../packages/registry/dist/index.js";
import { diffScorecards, runSuite, summarizeScorecard } from "../../packages/suite/dist/index.js";

const DATASET = process.env.DATASET ?? "datasets/webvoyager-mini.jsonl";
const TENANT = "acme";
const DS_ID = "webvoyager-mini";
const DS_VER = "1.0.0";

// import → tenant-owned registry → load.
const dataset = importWebVoyager(readFileSync(DATASET, "utf8"), { id: DS_ID, version: DS_VER });
const registry = new InMemoryDatasetRegistry();
await registry.register(TENANT, dataset);
const loaded = await registry.get(TENANT, DS_ID, DS_VER);
const suite = { id: loaded.id, harness: { id: "browser-use" }, cases: loaded.cases };

// extract the case's expected answer (answer-match grader config).
const expectOf = (c) => String(c.graders.find((g) => g.id === "answer-match")?.config?.expect ?? "");
// deterministic dispatch: put the answer answerFn produces into a trace message → score with the case graders.
const dispatchFor = (version, answerFn) => async (job) => {
  const c = job.evalCase;
  const answer = answerFn(c);
  const trace = [{ t: 0, kind: "message", role: "assistant", text: answer }];
  const snapshot = { kind: "browser", url: c.env.startUrl ?? "", dom: answer, console: [] };
  const scores = [];
  for (const g of makeGraders(c.graders)) scores.push(await g.grade({ case: c, trace, snapshot }));
  return { caseId: c.id, harness: `browser-use@${version}`, trace, snapshot, scores };
};

console.log("version regression diff — same tenant-owned dataset, two harness versions\n");
// vA (baseline): correct answer on every case → all pass.  vB (candidate): regression on the wikipedia cases (empty answer) → fail.
const scA = await runSuite(
  suite,
  "0.13.1",
  dispatchFor("0.13.1", (c) => expectOf(c)),
);
const scB = await runSuite(
  suite,
  "0.14.0-rc",
  dispatchFor("0.14.0-rc", (c) => (c.id.startsWith("wikipedia") ? "" : expectOf(c))),
);

// store both scorecards (tenant-scoped) — persistent records that can actually be compared.
const store = new InMemoryScorecardStore();
const now = new Date().toISOString();
for (const [sc, ver] of [
  [scA, "0.13.1"],
  [scB, "0.14.0-rc"],
]) {
  await store.create({
    id: `sc-${DS_ID}-${ver}`,
    tenant: TENANT,
    dataset: { id: DS_ID, version: DS_VER },
    harness: { id: "browser-use", version: ver },
    status: "succeeded",
    summary: summarizeScorecard(sc),
    scorecard: sc,
    createdAt: now,
    updatedAt: now,
  });
}
console.log(`stored scorecards for ${TENANT}: ${(await store.list(TENANT)).map((r) => r.harness.version).join(", ")}`);
console.log(
  `  vA ${scA.harness} answer_match passRate=${(summarizeScorecard(scA).find((s) => s.metric === "answer_match")?.passRate * 100).toFixed(0)}%`,
);
console.log(
  `  vB ${scB.harness} answer_match passRate=${(summarizeScorecard(scB).find((s) => s.metric === "answer_match")?.passRate * 100).toFixed(0)}%`,
);

// diff: objective pass transition.
const diff = diffScorecards(scA, scB);
console.log(`\n=== diff ${diff.baseline} → ${diff.candidate} ===`);
console.log(`regressions (pass→fail): ${diff.regressions.length}`);
for (const r of diff.regressions) console.log(`  ❌ ${r.caseId} [${r.metric}] ${r.baseline}→${r.candidate}`);
console.log(`improvements (fail→pass): ${diff.improvements.length}`);
for (const i of diff.improvements) console.log(`  ✅ ${i.caseId} [${i.metric}] ${i.baseline}→${i.candidate}`);
console.log(
  "metric deltas:",
  diff.metrics.map((m) => `${m.metric}:${m.delta >= 0 ? "+" : ""}${m.delta.toFixed(2)}`).join(" "),
);

const ok = diff.regressions.length === 2 && diff.regressions.every((r) => r.metric === "answer_match");
console.log(
  ok
    ? "\n✅ version regression diff e2e: evaluate a tenant-owned dataset with vA/vB → store in ScorecardStore → diffScorecards detects 2 wikipedia regressions (pass→fail). Multi-tenant regression tracking works."
    : "\n⚠️ regression detection mismatch",
);
process.exit(ok ? 0 : 1);
