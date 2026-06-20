// 라이브 e2e: 멀티테넌트 SaaS 데이터셋 평가 — import → tenant-owned registry → load → runSuite → Scorecard store.
// 유저 흐름 그대로: 외부 벤치마크(WebVoyager jsonl)를 @assay/datasets 로 import → DatasetRegistry.register(tenant)
// (유저-소유) → registry.get(tenant) 로 로드 → 실 browser-use 하니스로 per-case 평가 → Scorecard → ScorecardStore.
//
// 벤치마크: WebVoyager(github.com/MinorJerry/WebVoyager). 전체는 15개 상용사이트+VLM 채점 → 여기선 접근가능 서브셋
// (datasets/webvoyager-mini.jsonl, 동일 포맷). 같은 importer 가 전체 WebVoyager_data.jsonl 에도 동작(DATASET=).
//
// 준비: chromedp CDP + LiteLLM(gpt-5.4-mini) + browser-use venv. 환경: OPENAI_API_KEY, OPENAI_BASE_URL, CDP_URL, BU_PY.
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

// 1) import(외부 포맷 → Assay Dataset) → tenant-owned 레지스트리 등록(유저가 자기 워크스페이스에 추가).
const dataset = importWebVoyager(readFileSync(DATASET, "utf8"), {
  id: DS_ID,
  version: DS_VER,
  description: "WebVoyager mini",
});
const registry = new InMemoryDatasetRegistry();
await registry.register(TENANT, dataset);
console.log(`imported + registered: ${TENANT}/${DS_ID}@${DS_VER} (${dataset.cases.length} cases)`);

// 2) registry 에서 로드(테넌트-소유 round-trip) → Suite.
const loaded = await registry.get(TENANT, DS_ID, DS_VER);
const suite = { id: loaded.id, harness: { id: "browser-use" }, cases: loaded.cases };
console.log(`WebVoyager eval — ${suite.cases.length} cases × 실 browser-use(${HV}), dataset from registry\n`);

// 3) dispatch = 실 browser-use 에이전트로 케이스 1건 실행 → CaseResult(레지스트리 case 의 graders 로 채점).
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
  `\n✅ 멀티테넌트 dataset eval e2e: WebVoyager import → tenant-owned registry(${TENANT}) → load → 실 browser-use 평가 → Scorecard 저장. task success(answer_match)=${(passRate * 100).toFixed(0)}%.`,
);
process.exit(0);
