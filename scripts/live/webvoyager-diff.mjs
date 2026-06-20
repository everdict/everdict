// 라이브 e2e: 버전 회귀 diff — 같은 tenant-owned 데이터셋을 두 하니스 버전으로 평가 → diffScorecards.
// import → registry.register(tenant) → registry.get → runSuite(vA) + runSuite(vB) → ScorecardStore 저장 →
// diffScorecards(vA, vB) → 회귀(pass→fail)/개선(fail→pass) 리포트. (회귀 검출은 객관적 `pass` 전이로.)
//
// 주의: 회귀를 재현 가능하게 보이려고 두 버전 dispatch 는 **결정적 stand-in**(실 LLM 은 비결정적+느림 — 회귀 데모엔
// 부적합). diff(스코어카드 비교)는 실 @assay/suite diffScorecards. 실 하니스 평가는 webvoyager-eval.mjs 참고.
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

// 케이스의 기대답(answer-match grader config) 추출.
const expectOf = (c) => String(c.graders.find((g) => g.id === "answer-match")?.config?.expect ?? "");
// 결정적 dispatch: answerFn 이 만든 답을 trace 메시지로 → 케이스 graders 로 채점.
const dispatchFor = (version, answerFn) => async (job) => {
  const c = job.evalCase;
  const answer = answerFn(c);
  const trace = [{ t: 0, kind: "message", role: "assistant", text: answer }];
  const snapshot = { kind: "browser", url: c.env.startUrl ?? "", dom: answer, console: [] };
  const scores = [];
  for (const g of makeGraders(c.graders)) scores.push(await g.grade({ case: c, trace, snapshot }));
  return { caseId: c.id, harness: `browser-use@${version}`, trace, snapshot, scores };
};

console.log("버전 회귀 diff — 같은 tenant-owned 데이터셋, 두 하니스 버전\n");
// vA(baseline): 전 케이스 정답 → 전부 pass.  vB(candidate): wikipedia 케이스 회귀(빈 답) → fail.
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

// 두 스코어카드 저장(tenant-scoped) — 실제로 비교 가능한 영속 레코드.
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

// diff: 객관적 pass 전이.
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
    ? "\n✅ 버전 회귀 diff e2e: tenant-owned 데이터셋을 vA/vB 로 평가 → ScorecardStore 저장 → diffScorecards 가 wikipedia 2건 회귀(pass→fail) 검출. 멀티테넌트 회귀 추적 동작."
    : "\n⚠️ 회귀 검출 불일치",
);
process.exit(ok ? 0 : 1);
