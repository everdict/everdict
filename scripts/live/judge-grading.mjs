// 라이브 e2e: 채점 다양성 — 벤치마크마다 다른 채점 방식이 EvalCase.graders 프리셋으로 표현되고 실제로 작동.
//   WebVoyager → judge (실 LLM 모델 판정, makeGraders 에 Judge 주입)
//   GAIA       → answer-match exact (quasi-exact-match)
//   SWE-bench  → tests-pass + repo env (패치 후 타깃 테스트)
// judge 는 실 모델(LiteLLM gpt-5.4-mini, OPENAI_BASE_URL/OPENAI_API_KEY)로 트라젝토리를 판정한다.
import { readFileSync } from "node:fs";
import process from "node:process";
import { adapterToDataset, getBenchmark, importBenchmark } from "../../packages/datasets/dist/index.js";
import { makeGraders, modelJudge, openaiComplete } from "../../packages/graders/dist/index.js";

const MODEL = process.env.LLM_MODEL ?? "gpt-5.4-mini";
const apiKey = process.env.OPENAI_API_KEY ?? "";
const baseUrl = process.env.OPENAI_BASE_URL ?? "http://127.0.0.1:4000";
if (!apiKey) {
  console.error("OPENAI_API_KEY 미설정 — judge 모델 호출 불가");
  process.exit(2);
}
// 실 모델 judge: openaiComplete(전송) → modelJudge(판정 프롬프트) → Judge.
const judge = modelJudge(openaiComplete({ apiKey, model: MODEL, baseUrl }));

// ── 1) WebVoyager: judge(실 모델)로 트라젝토리 판정 ───────────────────────────────────────────
console.log("=== WebVoyager — judge(실 LLM) + answer-match + steps ===");
const wv = await importBenchmark(
  getBenchmark("webvoyager"),
  { id: "wv-mini", version: "1.0.0" },
  {
    text: readFileSync("datasets/webvoyager-mini.jsonl", "utf8"),
  },
);
console.log(`graders preset: ${wv.cases[0]?.graders.map((g) => g.id).join(" + ")}\n`);

for (let i = 0; i < wv.cases.length; i++) {
  const c = wv.cases[i];
  const expect = c.graders.find((g) => g.id === "answer-match")?.config?.expect ?? "";
  const wrong = i === wv.cases.length - 1; // 마지막 케이스는 일부러 오답 → judge 가 판별하는지 확인
  const answer = wrong
    ? "I was unable to complete the task and could not determine the answer."
    : `Based on the page content, the answer is: ${expect}.`;
  const trace = [
    { t: 0, kind: "tool_call", id: "a0", name: "navigate", args: { url: c.env.startUrl ?? "" } },
    { t: 1, kind: "tool_call", id: "a1", name: "read_page", args: {} },
    { t: 2, kind: "message", role: "assistant", text: answer },
  ];
  const snapshot = { kind: "browser", url: c.env.startUrl ?? "", dom: answer, console: [] };
  const scores = [];
  for (const g of makeGraders(c.graders, { judge })) scores.push(await g.grade({ case: c, trace, snapshot }));
  const j = scores.find((s) => s.graderId === "judge");
  const am = scores.find((s) => s.graderId === "answer-match");
  const st = scores.find((s) => s.graderId === "steps");
  console.log(`[${c.id}] answer=${JSON.stringify(answer.slice(0, 40))}${wrong ? " (intentionally wrong)" : ""}`);
  console.log(`   judge: pass=${j?.pass} score=${j?.value?.toFixed(2)} — ${String(j?.detail).slice(0, 90)}`);
  console.log(`   answer-match: ${am?.pass ? "PASS" : "fail"}   steps: ${st?.value}`);
}

// ── 2) GAIA: answer-match exact (gated → 샘플 행으로 프리셋 shape 확인) ─────────────────────────
console.log("\n=== GAIA — answer-match exact (quasi-exact-match) ===");
const gaia = adapterToDataset(
  getBenchmark("gaia"),
  [{ task_id: "g1", Question: "How many moons does Mars have?", "Final answer": "2", Level: "1" }],
  { id: "gaia-mini", version: "2023_all" },
);
console.log(`graders: ${JSON.stringify(gaia.cases[0]?.graders)}`);

// ── 3) SWE-bench Lite: repo env + tests-pass (실 HF 1행) ──────────────────────────────────────
console.log("\n=== SWE-bench Lite — repo env + tests-pass (HF 실데이터 1행) ===");
try {
  const swe = await importBenchmark(getBenchmark("swe-bench-lite"), { id: "swe-mini", version: "test" }, { limit: 1 });
  const c = swe.cases[0];
  console.log(`[${c.id}] env=${JSON.stringify(c.env)}`);
  const tp = c.graders.find((g) => g.id === "tests-pass");
  console.log(`   tests-pass cmd: ${String(tp?.config?.cmd).slice(0, 110)}…`);
  console.log(`   tags: ${JSON.stringify(c.tags)}`);
} catch (e) {
  console.log(`   SWE-bench HF 인출 실패: ${(e.message ?? "").slice(0, 100)}`);
}

console.log(
  "\n✅ 채점 다양성 e2e: 벤치마크별 grader 프리셋이 실제로 동작 — WebVoyager 는 실 LLM judge 가 트라젝토리를 판정(정답/오답 판별), GAIA 는 answer-match exact, SWE-bench 는 repo env + tests-pass. judge 는 makeGraders(specs,{judge}) 로 배선.",
);
process.exit(0);
