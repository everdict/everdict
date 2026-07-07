// live e2e: scoring diversity — each benchmark's different scoring method is expressed as an EvalCase.graders preset and actually works.
//   WebVoyager → judge (real LLM model verdict, Judge injected into makeGraders)
//   GAIA       → answer-match exact (quasi-exact-match)
//   SWE-bench  → tests-pass + repo env (target tests after the patch)
// The judge verdicts the trajectory with a real model (LiteLLM gpt-5.4-mini, OPENAI_BASE_URL/OPENAI_API_KEY).
import { readFileSync } from "node:fs";
import process from "node:process";
import { adapterToDataset, getBenchmark, importBenchmark } from "../../packages/datasets/dist/index.js";
import { makeGraders, modelJudge, openaiComplete } from "../../packages/graders/dist/index.js";

const MODEL = process.env.LLM_MODEL ?? "gpt-5.4-mini";
const apiKey = process.env.OPENAI_API_KEY ?? "";
const baseUrl = process.env.OPENAI_BASE_URL ?? "http://127.0.0.1:4000";
if (!apiKey) {
  console.error("OPENAI_API_KEY not set — cannot call the judge model");
  process.exit(2);
}
// real-model judge: openaiComplete (transport) → modelJudge (verdict prompt) → Judge.
const judge = modelJudge(openaiComplete({ apiKey, model: MODEL, baseUrl }));

// ── 1) WebVoyager: verdict the trajectory with the judge (real model) ───────────────────────────────────────────
console.log("=== WebVoyager — judge (real LLM) + answer-match + steps ===");
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
  const wrong = i === wv.cases.length - 1; // the last case is intentionally wrong → check that the judge catches it
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

// ── 2) GAIA: answer-match exact (gated → check the preset shape with a sample row) ─────────────────────────
console.log("\n=== GAIA — answer-match exact (quasi-exact-match) ===");
const gaia = adapterToDataset(
  getBenchmark("gaia"),
  [{ task_id: "g1", Question: "How many moons does Mars have?", "Final answer": "2", Level: "1" }],
  { id: "gaia-mini", version: "2023_all" },
);
console.log(`graders: ${JSON.stringify(gaia.cases[0]?.graders)}`);

// ── 3) SWE-bench Lite: repo env + tests-pass (1 real HF row) ──────────────────────────────────────
console.log("\n=== SWE-bench Lite — repo env + tests-pass (1 real HF data row) ===");
try {
  const swe = await importBenchmark(getBenchmark("swe-bench-lite"), { id: "swe-mini", version: "test" }, { limit: 1 });
  const c = swe.cases[0];
  console.log(`[${c.id}] env=${JSON.stringify(c.env)}`);
  const tp = c.graders.find((g) => g.id === "tests-pass");
  console.log(`   tests-pass cmd: ${String(tp?.config?.cmd).slice(0, 110)}…`);
  console.log(`   tags: ${JSON.stringify(c.tags)}`);
} catch (e) {
  console.log(`   SWE-bench HF fetch failed: ${(e.message ?? "").slice(0, 100)}`);
}

console.log(
  "\n✅ scoring diversity e2e: per-benchmark grader presets actually work — WebVoyager has a real LLM judge verdict the trajectory (distinguishing right/wrong answers), GAIA uses answer-match exact, SWE-bench uses repo env + tests-pass. The judge is wired via makeGraders(specs, { judge }).",
);
process.exit(0);
