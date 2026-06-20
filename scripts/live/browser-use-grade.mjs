// 라이브: 실 browser-use 라이브러리(자율 멀티스텝) e2e + 채점. 에이전트가 우리 모델(gpt-5.4-mini via LiteLLM)+
// CDP 브라우저(chromedp)로 과업을 자율 수행 → 결과를 outcome 그레이더로 채점. (browser-use Phase 2 — 실 하니스 완주.)
//   browser-use-agent.py(navigate+extract 자율) → BU_RESULT(final/steps/urls/done) → answer/url 그레이더.
//
// 준비: chromedp CDP(:9222) + LiteLLM(gpt-5.4-mini) + browser-use venv. 환경: OPENAI_API_KEY, OPENAI_BASE_URL,
//   CDP_URL, BU_PY(venv python), EXPECT(정답 substring, 기본 "Example Domain").
// 사용: OPENAI_API_KEY=... BU_PY=/tmp/bu-venv/bin/python node scripts/live/browser-use-grade.mjs
import { execFileSync } from "node:child_process";
import process from "node:process";

const PY = process.env.BU_PY ?? "python3";
const EXPECT = process.env.EXPECT ?? "Example Domain";

console.log("real browser-use library e2e — 자율 에이전트가 우리 모델+CDP 브라우저로 과업 수행 → 채점\n");
const out = execFileSync(PY, ["scripts/live/browser-use-agent.py"], {
  encoding: "utf8",
  env: {
    ...process.env,
    BU_MAX_STEPS: process.env.BU_MAX_STEPS ?? "6",
    BU_LLM_TIMEOUT: process.env.BU_LLM_TIMEOUT ?? "90",
  },
});
const m = /BU_RESULT=(\{.*\})/.exec(out);
if (!m) throw new Error(`browser-use 결과 없음:\n${out.slice(-400)}`);
const r = JSON.parse(m[1]);
console.log("final  :", JSON.stringify(r.final));
console.log("steps  :", r.steps, "| actions:", (r.actions ?? []).join(","), "| done:", r.done);
console.log("urls   :", (r.urls ?? []).join(" "));

// outcome 채점: (1) 자율 done, (2) 목표 URL 도달(브라우저 실제 구동), (3) 답에 기대 substring.
const navigated = (r.urls ?? []).some((u) => /example\.com/.test(u));
const answered = typeof r.final === "string" && r.final.includes(EXPECT);
const grades = [
  { id: "agent-done", pass: r.done === true, detail: `done=${r.done}` },
  { id: "browser-navigated", pass: navigated, detail: (r.urls ?? []).join(",") },
  { id: "answer-contains", pass: answered, detail: String(r.final).slice(0, 80) },
];
console.log("\nscores:", grades.map((g) => `${g.id}:${g.pass ? "pass" : "fail"}`).join(", "));
const ok = grades.every((g) => g.pass);
console.log(
  ok
    ? `\n✅ 실 browser-use 라이브러리 완주: 자율 에이전트가 gpt-5.4-mini 로 chromedp 브라우저를 구동해 example.com navigate+h1 추출("${EXPECT}")+done, outcome 채점 통과. browser-use Phase 2 — 실 하니스 e2e.`
    : "\n⚠️ 일부 grader fail",
);
process.exit(ok ? 0 : 1);
