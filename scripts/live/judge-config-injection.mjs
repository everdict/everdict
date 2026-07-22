// Live e2e (SLICE 56): per-run judge model config is injected control plane → alloc/agent so the judge works.
//   - model/provider come from job.judge (not a secret; the control plane puts it on the job)
//   - the provider 'key' comes from env (OPENAI_API_KEY/BASE_URL = mimics what the backend secretEnv injects into the alloc)
// process.env.EVERDICT_JUDGE_MODEL is intentionally cleared → the model must come only from job.judge.
import process from "node:process";
import { buildNomadJob } from "../../packages/backends/dist/index.js";
import { runCaseJob } from "../../packages/job-runner/dist/index.js";

// biome-ignore lint/performance/noDelete: clearing the process.env key is intentional (forces the model to come only from job.judge, not env)
delete process.env.EVERDICT_JUDGE_MODEL;
// biome-ignore lint/performance/noDelete: clearing the process.env key is intentional (test isolation)
delete process.env.EVERDICT_JUDGE_PROVIDER;

const job = {
  harness: { id: "scripted", version: "1.0.0" },
  tenant: "acme",
  judge: { provider: "openai", model: process.env.LLM_MODEL ?? "gpt-5.4-mini" }, // per-run config (the control plane decides)
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

// 1) Backend injection contract: buildNomadJob maps job.judge → alloc env (EVERDICT_JUDGE_MODEL/PROVIDER), key via secretEnv.
const spec = buildNomadJob(job, {
  addr: "http://nomad:4646",
  image: "reg/everdict-job-runner:1",
  secretEnv: { OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "", OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? "" },
});
const allocEnv = spec.Job.TaskGroups[0]?.Tasks[0]?.Env ?? {};
console.log("=== control plane → Nomad alloc env injection ===");
console.log(
  `  EVERDICT_JUDGE_MODEL=${allocEnv.EVERDICT_JUDGE_MODEL}  EVERDICT_JUDGE_PROVIDER=${allocEnv.EVERDICT_JUDGE_PROVIDER}`,
);
console.log(
  `  OPENAI_API_KEY=${allocEnv.OPENAI_API_KEY ? "<set via secretEnv>" : "<missing>"}  OPENAI_BASE_URL=${allocEnv.OPENAI_BASE_URL || "<unset>"}`,
);

// 2) Real dispatch (runCaseJob): model from job.judge, key from env (mimicking secretEnv) → real model verdict.
console.log("\n=== runCaseJob — model from job.judge, key from env(secretEnv) → real judge ===");
const result = await runCaseJob(job);
const j = result.scores.find((s) => s.metric === "judge");
console.log(`  scores: ${result.scores.map((s) => s.graderId).join(", ")}`);
console.log(`  judge: graderId=${j?.graderId} pass=${j?.pass} value=${j?.value?.toFixed?.(2) ?? j?.value}`);
console.log(`  judge detail: ${String(j?.detail).slice(0, 120)}`);

const ok =
  allocEnv.EVERDICT_JUDGE_MODEL === job.judge.model &&
  allocEnv.OPENAI_API_KEY &&
  j &&
  j.pass === true &&
  !String(j.detail).startsWith("skipped");

console.log(
  ok
    ? "\n✅ SLICE 56: the per-run judge model setting (job.judge) is injected from the control plane → alloc env (the key kept separate in secretEnv), and the agent does real judge scoring with that model. It works even with no model in process.env = the job-carried setting reaches the remote alloc."
    : "\n⚠️ does not match expectation",
);
process.exit(ok ? 0 : 1);
