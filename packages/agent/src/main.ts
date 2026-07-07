import { AgentJobSchema } from "@everdict/core";
import { RESULT_SENTINEL, runAgentJob } from "./run.js";

// 러너 에이전트 엔트리포인트(샌드박스/alloc 안에서 실행).
// AgentJob 은 base64(JSON) 로 EVERDICT_AGENT_JOB env 에 담겨 전달된다.
// 결과는 stdout 에 sentinel + CaseResult(JSON) 한 줄로 출력 → 백엔드가 로그에서 파싱.
async function main(): Promise<void> {
  const raw = process.env.EVERDICT_AGENT_JOB;
  if (!raw) {
    console.error("✗ EVERDICT_AGENT_JOB(env) 가 없습니다.");
    process.exitCode = 1;
    return;
  }
  const job = AgentJobSchema.parse(JSON.parse(Buffer.from(raw, "base64").toString("utf8")));
  const result = await runAgentJob(job);
  console.log(RESULT_SENTINEL + JSON.stringify(result));
}

void main();
