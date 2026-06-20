// 라이브 e2e: 실 브라우저 벤치마크(WebVoyager 포맷) 데이터셋을 이 하니스로 평가 → Scorecard.
// dataset(jsonl) → Suite(EvalCase[]) → dispatch=실 browser-use 에이전트(per-case, 우리 모델+CDP 브라우저) →
// makeGraders(answer-match/steps) 채점 → CaseResult → runSuite → Scorecard → summarizeScorecard.
//
// 벤치마크: WebVoyager(https://github.com/MinorJerry/WebVoyager) — 자율 웹 에이전트용. 전체는 15개 상용 사이트 +
// VLM 채점이라 여기선 접근가능+정답대조 가능한 소규모 서브셋(datasets/webvoyager-mini.jsonl, 동일 포맷)으로 e2e.
// 같은 로더가 전체 WebVoyager_data.jsonl 에도 동작(DATASET 환경변수로 교체).
//
// 준비: chromedp CDP(:9222) + LiteLLM(gpt-5.4-mini) + browser-use venv. 환경: OPENAI_API_KEY, OPENAI_BASE_URL,
//   CDP_URL, BU_PY, DATASET. 사용: OPENAI_API_KEY=... BU_PY=/tmp/bu-venv/bin/python node scripts/live/webvoyager-eval.mjs
import { execFileSync } from "node:child_process";
import { readFileSync as rf } from "node:fs";
import process from "node:process";
import { makeGraders } from "../../packages/graders/dist/index.js";
import { runSuite, summarizeScorecard } from "../../packages/suite/dist/index.js";

const PY = process.env.BU_PY ?? "python3";
const DATASET = process.env.DATASET ?? "datasets/webvoyager-mini.jsonl";
const VERSION = "0.13.1";

// 1) dataset(WebVoyager jsonl) → Suite(EvalCase[]).
const rows = rf(DATASET, "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));
const suite = {
  id: "webvoyager-mini",
  harness: { id: "browser-use", version: VERSION },
  cases: rows.map((r) => ({
    id: r.id,
    env: { kind: "browser", startUrl: r.web },
    task: r.ques,
    graders: [
      { id: "answer-match", config: { expect: r.answer } }, // 벤치마크 정답대조(주 지표)
      { id: "steps" }, // 궤적: 액션 수
    ],
    timeoutSec: 600,
    tags: ["webvoyager", r.web_name],
  })),
};
console.log(`WebVoyager eval — ${suite.cases.length} cases × 실 browser-use 하니스(${VERSION})\n`);

// 2) dispatch = 실 browser-use 에이전트로 케이스 1건 실행 → CaseResult(채점 포함).
const dispatch = async (job) => {
  const c = job.evalCase;
  const task = `Go to ${c.env.startUrl} and answer this question: ${c.task}`;
  let result = { final: "", steps: 0, actions: [], urls: [], done: false };
  try {
    const out = execFileSync(PY, ["scripts/live/browser-use-agent.py"], {
      encoding: "utf8",
      env: { ...process.env, BU_TASK: task, BU_MAX_STEPS: "8", BU_LLM_TIMEOUT: "90" },
    });
    const m = /BU_RESULT=(\{.*\})/.exec(out);
    if (m) result = JSON.parse(m[1]);
  } catch (e) {
    console.log(`  [${c.id}] agent error: ${(e.message ?? "").slice(0, 80)}`);
  }
  // browser-use 결과 → 정규화 trace/snapshot(그레이더 입력).
  const trace = [
    ...(result.actions ?? []).map((a, i) => ({ t: i, kind: "tool_call", id: `a${i}`, name: a, args: {} })),
    { t: 999, kind: "message", role: "assistant", text: result.final ?? "" },
  ];
  const snapshot = {
    kind: "browser",
    url: (result.urls ?? []).at(-1) ?? c.env.startUrl,
    dom: result.final ?? "",
    console: [],
  };
  const scores = [];
  for (const g of makeGraders(c.graders)) scores.push(await g.grade({ case: c, trace, snapshot }));
  const am = scores.find((s) => s.graderId === "answer-match");
  console.log(
    `  [${c.id}] answer=${JSON.stringify((result.final ?? "").slice(0, 50))} → answer-match:${am?.pass ? "PASS" : "fail"} steps:${result.steps}`,
  );
  return { caseId: c.id, harness: `${suite.harness.id}@${VERSION}`, trace, snapshot, scores };
};

// 3) runSuite → Scorecard (순차 — 단일 브라우저+LLM).
const scorecard = await runSuite(suite, VERSION, dispatch, { concurrency: 1 });

// 4) 집계.
console.log("\n=== Scorecard:", scorecard.harness, "===");
for (const s of summarizeScorecard(scorecard)) {
  console.log(`  ${s.metric}: passRate=${(s.passRate * 100).toFixed(0)}%  mean=${s.mean.toFixed(2)}  n=${s.count}`);
}
const answer = summarizeScorecard(scorecard).find((s) => s.metric === "answer_match");
const passRate = answer?.passRate ?? 0;
console.log(
  `\n${passRate > 0 ? "✅" : "⚠️"} WebVoyager-format 벤치마크를 이 하니스로 e2e 평가: dataset→Suite→실 browser-use per-case→answer-match 채점→Scorecard. task success(answer_match) passRate=${(passRate * 100).toFixed(0)}%.`,
);
process.exit(0);
