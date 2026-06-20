// 라이브 e2e: judge grader 가 "일반 dispatch 경로"(runAgentJob)로 흐르는지 — 별도 judge-runner 가 아니라
// EvalCase.graders 의 judge 프리셋이 실제 평가 루프에서 실 모델 판정으로 채점된다.
//   환경 O (ASSAY_JUDGE_MODEL + OPENAI 키) → judge grader = 실 모델 판정(pass/score/reason)
//   환경 X                                  → judge grader = skip 점수(일반 eval 안 죽음)
// 하니스는 scripted(키 불필요): `echo hello > out.txt` 를 실제 실행 → 진짜 trace → judge 가 그 trace 를 판정.
import process from "node:process";
import { runAgentJob } from "../../packages/agent/dist/index.js";

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

// 1) judge 모델 구성됨 → 실 모델 판정.
console.log("=== runAgentJob (judge 환경 O) — 실 모델이 trace 를 판정 ===");
const real = await runAgentJob(baseJob);
const realJudge = showJudge("env O", real);

// 2) judge 모델 미구성 → judge 만 skip(나머지 정상).
// biome-ignore lint/performance/noDelete: process.env 키 제거가 의도(미구성 상태 재현)
delete process.env.ASSAY_JUDGE_MODEL;
console.log("\n=== runAgentJob (judge 환경 X) — judge 는 skip, eval 은 계속 ===");
const skipped = await runAgentJob(baseJob);
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
    ? "\n✅ judge 가 일반 dispatch 경로(runAgentJob)로 스레딩됨: 환경 O 면 실 모델이 trace 를 판정(pass), 환경 X 면 judge 만 skip 점수(eval 지속). WebVoyager 류 judge 프리셋이 정상 eval 에서 자동 채점됨."
    : "\n⚠️ 기대와 불일치",
);
process.exit(ok ? 0 : 1);
