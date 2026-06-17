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

// 워크플로 레벨 팬아웃 상한 — 대형 스위트가 액티비티 슬롯을 한꺼번에 점유하지 않게 한다.
// (세밀한 클러스터 용량 게이팅은 워커의 Scheduler 가 추가로 수행한다.)
const SUITE_FANOUT = 8;

// 스위트 = 여러 케이스를 bounded 팬아웃으로 디스패치(각 액티비티가 독립적으로 재시도).
// 결정적: 레인 worker 들이 공유 카운터로 인덱스를 집고, 결과는 인덱스로 채운다(Temporal replay 안전).
export async function suiteWorkflow(jobs: AgentJob[]): Promise<CaseResult[]> {
  const results = new Array<CaseResult>(jobs.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < jobs.length) {
      const i = next++;
      const job = jobs[i];
      if (job === undefined) continue;
      results[i] = await dispatchCase(job);
    }
  };
  const lanes = Math.max(1, Math.min(SUITE_FANOUT, jobs.length));
  await Promise.all(Array.from({ length: lanes }, () => lane()));
  return results;
}
