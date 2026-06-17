import type { AgentJob, CaseResult } from "@assay/core";
import { proxyActivities } from "@temporalio/workflow";
import type { Activities } from "./types.js";

// ⚠ 워크플로 코드는 결정적(deterministic)이어야 한다 — I/O 금지, 순수 타입만 import.
// 실제 백엔드 디스패치는 액티비티(dispatchCase)에서 일어난다(재시도/타임아웃 가능).
const { dispatchCase } = proxyActivities<Activities>({
  startToCloseTimeout: "1 hour", // Nomad alloc + claude 실행은 길 수 있다
  retry: { maximumAttempts: 3 },
});

// 한 케이스 = durable 워크플로 실행. 컨트롤플레인이 죽어도 재개된다.
export async function evalCaseWorkflow(job: AgentJob): Promise<CaseResult> {
  return dispatchCase(job);
}

// 스위트 = 여러 케이스를 병렬 디스패치(각 액티비티가 독립적으로 재시도).
export async function suiteWorkflow(jobs: AgentJob[]): Promise<CaseResult[]> {
  return Promise.all(jobs.map((job) => dispatchCase(job)));
}
