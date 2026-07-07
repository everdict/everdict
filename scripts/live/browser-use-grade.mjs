// Live: real browser-use library (autonomous multi-step) e2e + grading. The agent autonomously performs the task
// with our model (gpt-5.4-mini via LiteLLM) + a CDP browser (chromedp) → grade the result with outcome graders. (browser-use Phase 2 — full real-harness run.)
//   browser-use-agent.py (autonomous navigate+extract) → BU_RESULT (final/steps/urls/done) → answer/url graders.
//
// Setup: chromedp CDP (:9222) + LiteLLM (gpt-5.4-mini) + browser-use venv. Env: OPENAI_API_KEY, OPENAI_BASE_URL,
//   CDP_URL, BU_PY (venv python), EXPECT (expected-answer substring, default "Example Domain").
// Usage: OPENAI_API_KEY=... BU_PY=/tmp/bu-venv/bin/python node scripts/live/browser-use-grade.mjs
import { execFileSync } from "node:child_process";
import process from "node:process";

const PY = process.env.BU_PY ?? "python3";
const EXPECT = process.env.EXPECT ?? "Example Domain";

console.log(
  "real browser-use library e2e — an autonomous agent performs the task with our model + CDP browser → grade\n",
);
const out = execFileSync(PY, ["scripts/live/browser-use-agent.py"], {
  encoding: "utf8",
  env: {
    ...process.env,
    BU_MAX_STEPS: process.env.BU_MAX_STEPS ?? "6",
    BU_LLM_TIMEOUT: process.env.BU_LLM_TIMEOUT ?? "90",
  },
});
const m = /BU_RESULT=(\{.*\})/.exec(out);
if (!m) throw new Error(`no browser-use result:\n${out.slice(-400)}`);
const r = JSON.parse(m[1]);
console.log("final  :", JSON.stringify(r.final));
console.log("steps  :", r.steps, "| actions:", (r.actions ?? []).join(","), "| done:", r.done);
console.log("urls   :", (r.urls ?? []).join(" "));

// Outcome grading: (1) autonomous done, (2) reached the target URL (browser actually driven), (3) expected substring in the answer.
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
    ? `\n✅ Real browser-use library completed: an autonomous agent drove the chromedp browser with gpt-5.4-mini to navigate example.com + extract the h1 ("${EXPECT}") + done, passing outcome grading. browser-use Phase 2 — real-harness e2e.`
    : "\n⚠️ some graders failed",
);
process.exit(ok ? 0 : 1);
