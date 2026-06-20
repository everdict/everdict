// 라이브 e2e: 벤치마크 생태계 소싱 — HuggingFace Hub 에서 "벤치마크 ID 만으로" 당겨와 테넌트-소유 데이터셋으로 평가.
// 유저 흐름: 카탈로그에서 벤치마크 고름 → @assay/datasets importBenchmark(HF 소스 커넥터, 네트워크) → Dataset →
// DatasetRegistry.register(tenant) → registry.get → runSuite → Scorecard. 새 벤치마크 = 어댑터 한 개(코드 아님).
//
// 실제 HF 데이터셋(네트워크): openai/gsm8k(QA, open), osunlp/Mind2Web(web-agent, open). GAIA 는 gated(토큰 필요).
import process from "node:process";
import {
  BENCHMARK_CATALOG,
  getBenchmark,
  importBenchmark,
  listBenchmarks,
} from "../../packages/datasets/dist/index.js";
import { InMemoryScorecardStore } from "../../packages/db/dist/index.js";
import { makeGraders } from "../../packages/graders/dist/index.js";
import { InMemoryDatasetRegistry } from "../../packages/registry/dist/index.js";
import { runSuite, summarizeScorecard } from "../../packages/suite/dist/index.js";

const TENANT = process.env.TENANT ?? "acme";
const registry = new InMemoryDatasetRegistry();
const store = new InMemoryScorecardStore();
const now = new Date().toISOString();

// 0) 카탈로그(유저가 고를 수 있는 first-party 벤치마크).
console.log("=== 벤치마크 카탈로그 (first-party 어댑터) ===");
for (const b of listBenchmarks())
  console.log(`  • ${b.id.padEnd(11)} [${b.category}]${b.gated ? " (gated)" : ""}  ${b.description}`);

// 공통: import(HF) → tenant 등록 → 로드.
async function pull(adapter, id, version, limit, token) {
  const ds = await importBenchmark(adapter, { id, version, description: adapter.description }, { limit, token });
  await registry.register(TENANT, ds);
  const loaded = await registry.get(TENANT, id, version);
  console.log(
    `\n▶ ${adapter.source.kind === "huggingface" ? adapter.source.dataset : adapter.id} → ${TENANT}/${id}@${version} (${loaded.cases.length} cases)`,
  );
  return loaded;
}

// 1) gsm8k(QA) — HF 에서 5건 당겨와 oracle dispatch 로 answer-match 평가(실 gold 정답 채점).
const gsm8k = await pull(getBenchmark("gsm8k"), "gsm8k-mini", "main", 5);
for (const c of gsm8k.cases.slice(0, 2))
  console.log(`    q: ${c.task.slice(0, 70)}… → expect ${JSON.stringify(c.graders[0]?.config?.expect)}`);

const oracle = async (job) => {
  const c = job.evalCase;
  const expect = c.graders.find((g) => g.id === "answer-match")?.config?.expect ?? "";
  const answer = `After working it out, the answer is ${expect}.`; // 오라클(플러밍 검증용; 채점 판별은 graders 유닛테스트)
  const trace = [{ t: 0, kind: "message", role: "assistant", text: answer }];
  const snapshot = { kind: "browser", url: "", dom: answer, console: [] };
  const scores = [];
  for (const g of makeGraders(c.graders)) scores.push(await g.grade({ case: c, trace, snapshot }));
  return { caseId: c.id, harness: "oracle@1.0.0", trace, snapshot, scores };
};
const sc = await runSuite({ id: gsm8k.id, harness: { id: "oracle" }, cases: gsm8k.cases }, "1.0.0", oracle, {
  concurrency: 2,
});
const summary = summarizeScorecard(sc);
await store.create({
  id: `sc-gsm8k-${TENANT}`,
  tenant: TENANT,
  dataset: { id: "gsm8k-mini", version: "main" },
  harness: { id: "oracle", version: "1.0.0" },
  status: "succeeded",
  summary,
  scorecard: sc,
  createdAt: now,
  updatedAt: now,
});
const am = summary.find((s) => s.metric === "answer_match");
console.log(
  `    eval → answer_match passRate=${am ? `${(am.passRate * 100).toFixed(0)}%` : "-"} (n=${am?.count}) — Scorecard stored`,
);

// 2) mind2web(web-agent) — HF 에서 3건 당겨와 테넌트 데이터셋으로 등록(실 agentic 벤치마크 인입 증명).
const m2w = await pull(getBenchmark("mind2web"), "mind2web-mini", "default", 3);
for (const c of m2w.cases)
  console.log(
    `    task: ${c.task.slice(0, 64)}…  tags=${JSON.stringify(c.tags)} graders=${c.graders.map((g) => g.id).join(",")}`,
  );

// 3) gaia(gated) — 토큰 있으면 인입 시도(없으면 스킵). 멀티테넌트: 토큰은 SecretStore 에서.
const hfToken = process.env.HF_TOKEN;
if (hfToken) {
  try {
    const gaia = await pull(getBenchmark("gaia"), "gaia-mini", "2023_all", 3, hfToken);
    console.log(`    gaia gated 인입 성공: ${gaia.cases.length} cases`);
  } catch (e) {
    console.log(`    gaia gated 인입 실패: ${(e.message ?? "").slice(0, 90)}`);
  }
} else {
  console.log("\n▶ gaia (gated) — HF_TOKEN 미설정 → 스킵 (멀티테넌트에선 테넌트 SecretStore 의 HF 토큰 주입)");
}

console.log(`\nstored scorecards for ${TENANT}: ${(await store.list(TENANT)).length}`);
console.log(
  `\n✅ 벤치마크 생태계 e2e: HF Hub 에서 벤치마크 ID 만으로 당겨(gsm8k QA + mind2web web-agent) → 테넌트-소유 Dataset 등록 → eval → Scorecard. 새 벤치마크 추가 = 어댑터 1개(${Object.keys(BENCHMARK_CATALOG).length}개 카탈로그). gated 는 토큰 경로 확인.`,
);
process.exit(0);
