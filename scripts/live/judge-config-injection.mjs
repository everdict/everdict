// 라이브 e2e (SLICE 56): per-run judge 모델 설정이 컨트롤플레인 → alloc/agent 로 주입되어 judge 가 작동.
//   - 모델/프로바이더는 job.judge (시크릿 아님, 컨트롤플레인이 잡에 실음)
//   - 프로바이더 '키'는 env(OPENAI_API_KEY/BASE_URL = 백엔드 secretEnv 가 alloc 에 주입하는 것을 모사)
// process.env.ASSAY_JUDGE_MODEL 은 일부러 비운다 → 모델은 오직 job.judge 에서 와야 한다.
import process from "node:process";
import { runAgentJob } from "../../packages/agent/dist/index.js";
import { buildNomadJob } from "../../packages/backends/dist/index.js";

delete process.env.ASSAY_JUDGE_MODEL; // 모델은 env 가 아니라 job.judge 로만 와야 함을 강제
delete process.env.ASSAY_JUDGE_PROVIDER;

const job = {
  harness: { id: "scripted", version: "1.0.0" },
  tenant: "acme",
  judge: { provider: "openai", model: process.env.LLM_MODEL ?? "gpt-5.4-mini" }, // per-run 설정(컨트롤플레인이 결정)
  evalCase: {
    id: "create-file",
    env: { kind: "repo", source: { files: {} } },
    task: "Create a file out.txt containing hello.",
    graders: [
      { id: "steps" },
      { id: "judge", config: { id: "task-judge", rubric: "Did the agent run a command that creates out.txt? Pass only if a tool call did so." } },
    ],
    timeoutSec: 120,
    tags: [],
  },
};

// 1) 백엔드 주입 계약: buildNomadJob 이 job.judge → alloc env(ASSAY_JUDGE_MODEL/PROVIDER), 키는 secretEnv.
const spec = buildNomadJob(job, {
  addr: "http://nomad:4646",
  image: "reg/assay-agent:1",
  secretEnv: { OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "", OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? "" },
});
const allocEnv = spec.Job.TaskGroups[0]?.Tasks[0]?.Env ?? {};
console.log("=== 컨트롤플레인 → Nomad alloc env 주입 ===");
console.log(`  ASSAY_JUDGE_MODEL=${allocEnv.ASSAY_JUDGE_MODEL}  ASSAY_JUDGE_PROVIDER=${allocEnv.ASSAY_JUDGE_PROVIDER}`);
console.log(`  OPENAI_API_KEY=${allocEnv.OPENAI_API_KEY ? "<set via secretEnv>" : "<missing>"}  OPENAI_BASE_URL=${allocEnv.OPENAI_BASE_URL || "<unset>"}`);

// 2) 실제 dispatch(runAgentJob): 모델은 job.judge 에서, 키는 env(secretEnv 모사)에서 → 실 모델 판정.
console.log("\n=== runAgentJob — 모델은 job.judge, 키는 env(secretEnv) → 실 judge ===");
const result = await runAgentJob(job);
const j = result.scores.find((s) => s.metric === "judge");
console.log(`  scores: ${result.scores.map((s) => s.graderId).join(", ")}`);
console.log(`  judge: graderId=${j?.graderId} pass=${j?.pass} value=${j?.value?.toFixed?.(2) ?? j?.value}`);
console.log(`  judge detail: ${String(j?.detail).slice(0, 120)}`);

const ok =
  allocEnv.ASSAY_JUDGE_MODEL === job.judge.model &&
  allocEnv.OPENAI_API_KEY &&
  j &&
  j.pass === true &&
  !String(j.detail).startsWith("skipped");

console.log(
  ok
    ? "\n✅ SLICE 56: per-run judge 모델 설정(job.judge)이 컨트롤플레인 → alloc env 로 주입되고(키는 secretEnv 분리), agent 가 그 모델로 실 judge 채점. process.env 에 모델이 없어도 동작 = 잡-반송 설정이 원격 alloc 까지 도달."
    : "\n⚠️ 기대와 불일치",
);
process.exit(ok ? 0 : 1);
