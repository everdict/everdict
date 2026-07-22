// live e2e: whether the judge grader flows through the "normal dispatch path" (runCaseJob) — not a separate judge-runner,
// but the judge preset in EvalCase.graders is scored with a real model verdict in the actual eval loop.
//   env set (EVERDICT_JUDGE_MODEL + OPENAI key) → judge grader = real model verdict (pass/score/reason)
//   env unset                                   → judge grader = skip score (normal eval does not die)
// The harness is scripted (no key needed): actually runs `echo hello > out.txt` → a real trace → the judge verdicts that trace.
import process from "node:process";
import { runCaseJob } from "../../packages/job-runner/dist/index.js";

const baseJob = {
  harness: { id: "scripted", version: "1.0.0" },
  tenant: "acme",
  evalCase: {
    id: "create-file",
    env: { kind: "repo", source: { files: {} } },
    task: "Create a file out.txt containing hello.",
    graders: [
      { id: "steps" },
      {
        id: "judge",
        config: {
          id: "task-judge",
          rubric: "Did the agent run a command that creates out.txt? Pass only if a tool call did so.",
        },
      },
    ],
    timeoutSec: 120,
    tags: [],
  },
};

function showJudge(label, result) {
  const j = result.scores.find((s) => s.metric === "judge");
  const steps = result.scores.find((s) => s.metric === "steps");
  console.log(`\n[${label}] scores: ${result.scores.map((s) => s.graderId).join(", ")}  (steps=${steps?.value})`);
  console.log(`   judge: graderId=${j?.graderId} pass=${j?.pass} value=${j?.value?.toFixed?.(2) ?? j?.value}`);
  console.log(`   judge detail: ${String(j?.detail).slice(0, 120)}`);
  return j;
}

// 1) judge model configured → real model verdict.
console.log("=== runCaseJob (judge env set) — the real model verdicts the trace ===");
const real = await runCaseJob(baseJob);
const realJudge = showJudge("env O", real);

// 2) judge model not configured → only the judge is skipped (the rest is normal).
// biome-ignore lint/performance/noDelete: removing the process.env key is intentional (reproduces the unconfigured state)
delete process.env.EVERDICT_JUDGE_MODEL;
console.log("\n=== runCaseJob (judge env unset) — the judge is skipped, eval continues ===");
const skipped = await runCaseJob(baseJob);
const skipJudge = showJudge("env X", skipped);

const ok =
  realJudge &&
  realJudge.pass === true &&
  realJudge.detail &&
  !String(realJudge.detail).startsWith("skipped") &&
  skipJudge &&
  skipJudge.pass === undefined &&
  String(skipJudge.detail).startsWith("skipped");

console.log(
  ok
    ? "\n✅ the judge threads through the normal dispatch path (runCaseJob): with env set the real model verdicts the trace (pass), with env unset only the judge gets a skip score (eval continues). WebVoyager-style judge presets are scored automatically in a normal eval."
    : "\n⚠️ does not match expectation",
);
process.exit(ok ? 0 : 1);
