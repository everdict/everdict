// Live e2e (SLICE 69): prompt env kind — environment-less QA (gsm8k/GAIA style) as a first-class case, with no repo/browser workaround.
//   A) gsm8k adapter → case.env = {kind:"prompt"} (data)
//   B) runAgentJob picks PromptEnvironment for prompt cases (previously RepoEnvironment.seed would throw) → snapshot.kind=prompt
//   C) runCase(PromptEnvironment + QA harness + answer-match) → pass if the answer matches (QA eval without browser/repo)
import process from "node:process";
import { runAgentJob } from "../../packages/agent/dist/index.js";
import { adapterToDataset, getBenchmark } from "../../packages/datasets/dist/index.js";
import { LocalDriver } from "../../packages/drivers/dist/index.js";
import { PromptEnvironment } from "../../packages/environments/dist/index.js";
import { makeGraders } from "../../packages/graders/dist/index.js";
import { runCase } from "../../packages/runner/dist/index.js";

// A) the gsm8k adapter emits a prompt env as data.
const ds = adapterToDataset(getBenchmark("gsm8k"), [{ question: "2+2?", answer: "calc … #### 4" }], {
  id: "gsm8k-mini",
  version: "main",
});
console.log("=== A) gsm8k adapter → env ===");
console.log(`  case.env = ${JSON.stringify(ds.cases[0].env)}  graders=${JSON.stringify(ds.cases[0].graders)}`);
const aOk = ds.cases[0].env.kind === "prompt";

// B) runAgentJob picks PromptEnvironment for the prompt case (previously it was RepoEnvironment, which threw).
const promptCase = {
  id: "qa-1",
  env: { kind: "prompt" },
  task: "How many moons does Mars have?",
  graders: [{ id: "answer-match", config: { expect: "2" } }],
  timeoutSec: 60,
  tags: [],
};
console.log("\n=== B) runAgentJob(prompt case, scripted harness) — env selection ===");
const jobResult = await runAgentJob({
  evalCase: promptCase,
  harness: { id: "scripted", version: "1.0.0" },
  tenant: "acme",
});
console.log(
  `  result.snapshot.kind = ${jobResult.snapshot.kind} (PromptEnvironment selected; RepoEnvironment would have thrown on seed)`,
);
const bOk = jobResult.snapshot.kind === "prompt";

// C) runCase(PromptEnvironment + QA harness + answer-match) — QA eval without browser/repo.
const qaHarness = (answer) => ({
  id: "qa",
  version: "1.0.0",
  async install() {},
  async *run(_compute, task) {
    yield { t: 0, kind: "message", role: "user", text: task };
    yield { t: 1, kind: "message", role: "assistant", text: answer };
  },
});
console.log("\n=== C) runCase(PromptEnvironment + QA harness) — answer-match grading ===");
const result = await runCase(promptCase, {
  driver: new LocalDriver(),
  environment: new PromptEnvironment(),
  harness: qaHarness("Mars has 2 moons."),
  graders: makeGraders(promptCase.graders),
  runCtx: { apiKeyEnv: {}, timeoutSec: 60 },
});
const am = result.scores.find((s) => s.metric === "answer_match");
console.log(`  snapshot.kind=${result.snapshot.kind}  answer-match: pass=${am?.pass}`);

const ok = aOk && bOk && am?.pass === true;
console.log(
  ok
    ? "\n✅ SLICE 69: prompt env kind — gsm8k/GAIA-style QA expressed first-class as an environment-less prompt env. runAgentJob picks PromptEnvironment by env.kind (removes the repo/browser workaround), runCase grades the answer (pass) with PromptEnvironment + QA harness + answer-match. Pure QA eval with no browser/repo stage."
    : `\n⚠️ does not match expectations (a=${aOk} b=${bOk} c=${am?.pass})`,
);
process.exit(ok ? 0 : 1);
