// 라이브 e2e (SLICE 69): prompt env kind — 환경 없는 QA(gsm8k/GAIA 류)를 repo/browser 우회 없이 1급으로.
//   A) gsm8k 어댑터 → case.env = {kind:"prompt"} (데이터)
//   B) runAgentJob 이 prompt 케이스에 PromptEnvironment 선택(이전엔 RepoEnvironment.seed 가 throw) → snapshot.kind=prompt
//   C) runCase(PromptEnvironment + QA 하니스 + answer-match) → 답 맞으면 pass (browser/repo 없이 QA 평가)
import process from "node:process";
import { runAgentJob } from "../../packages/agent/dist/index.js";
import { adapterToDataset, getBenchmark } from "../../packages/datasets/dist/index.js";
import { LocalDriver } from "../../packages/drivers/dist/index.js";
import { PromptEnvironment } from "../../packages/environments/dist/index.js";
import { makeGraders } from "../../packages/graders/dist/index.js";
import { runCase } from "../../packages/runner/dist/index.js";

// A) gsm8k 어댑터가 prompt env 를 데이터로 emit.
const ds = adapterToDataset(getBenchmark("gsm8k"), [{ question: "2+2?", answer: "calc … #### 4" }], {
  id: "gsm8k-mini",
  version: "main",
});
console.log("=== A) gsm8k 어댑터 → env ===");
console.log(`  case.env = ${JSON.stringify(ds.cases[0].env)}  graders=${JSON.stringify(ds.cases[0].graders)}`);
const aOk = ds.cases[0].env.kind === "prompt";

// B) runAgentJob 이 prompt 케이스에 PromptEnvironment 를 선택(이전엔 RepoEnvironment 라 throw).
const promptCase = {
  id: "qa-1",
  env: { kind: "prompt" },
  task: "How many moons does Mars have?",
  graders: [{ id: "answer-match", config: { expect: "2" } }],
  timeoutSec: 60,
  tags: [],
};
console.log("\n=== B) runAgentJob(prompt 케이스, scripted 하니스) — env 선택 ===");
const jobResult = await runAgentJob({
  evalCase: promptCase,
  harness: { id: "scripted", version: "1.0.0" },
  tenant: "acme",
});
console.log(
  `  result.snapshot.kind = ${jobResult.snapshot.kind} (PromptEnvironment 선택됨; RepoEnvironment 였다면 seed throw)`,
);
const bOk = jobResult.snapshot.kind === "prompt";

// C) runCase(PromptEnvironment + QA 하니스 + answer-match) — browser/repo 없이 QA 평가.
const qaHarness = (answer) => ({
  id: "qa",
  version: "1.0.0",
  async install() {},
  async *run(_compute, task) {
    yield { t: 0, kind: "message", role: "user", text: task };
    yield { t: 1, kind: "message", role: "assistant", text: answer };
  },
});
console.log("\n=== C) runCase(PromptEnvironment + QA 하니스) — answer-match 채점 ===");
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
    ? "\n✅ SLICE 69: prompt env kind — gsm8k/GAIA 류 QA 가 환경 없는 prompt env 로 1급 표현. runAgentJob 이 env.kind 로 PromptEnvironment 선택(repo/browser 우회 제거), runCase 가 PromptEnvironment + QA 하니스 + answer-match 로 답을 채점(pass). browser/repo 무대 없이 순수 QA 평가."
    : `\n⚠️ 기대와 불일치 (a=${aOk} b=${bOk} c=${am?.pass})`,
);
process.exit(ok ? 0 : 1);
