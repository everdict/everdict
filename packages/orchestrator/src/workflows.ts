import type { AgentJob, CaseResult } from "@assay/core";
import { proxyActivities, sleep } from "@temporalio/workflow";
import type { Activities } from "./types.js";

// ⚠ 워크플로 코드는 결정적(deterministic)이어야 한다 — I/O 금지, 순수 타입만 import.
// 실제 백엔드 디스패치는 액티비티(dispatchCase)에서 일어난다(재시도/타임아웃 가능).
const { dispatchCase } = proxyActivities<Activities>({
  startToCloseTimeout: "1 hour", // Nomad alloc + claude 실행은 길 수 있다
  retry: { maximumAttempts: 3 },
});

// 예약 발사/폴링 액티비티 — internal HTTP 라우트라 짧은 타임아웃.
const { fireScheduledScorecard, scheduledScorecardStatus } = proxyActivities<Activities>({
  startToCloseTimeout: "2 minutes",
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

// 예약(cron) 발사 워크플로 — Temporal Schedule 이 cron 마다 시작한다(TemporalScheduleDriver).
// fire(스코어카드 submit) 후 종료까지 폴링한다 — 워크플로 수명 = 실제 스코어카드 수명이 되어야 Schedule 의
// overlap 정책(Skip/BufferOne)이 의미를 갖는다(submit 은 즉시 queued 를 반환하므로 fire-and-forget 이면 무의미).
// 설계: docs/architecture/scheduled-evals.md.
const POLL_INTERVAL_MS = 30_000;
const MAX_POLLS = 480; // ~4시간 상한(30s × 480) — 무한 대기 방지

export async function scheduledScorecardWorkflow(input: { scheduleId: string; tenant: string }): Promise<void> {
  const { scorecardId } = await fireScheduledScorecard(input);
  for (let i = 0; i < MAX_POLLS; i++) {
    const status = await scheduledScorecardStatus(scorecardId);
    if (status === "succeeded" || status === "failed") return; // 종료 → 워크플로 종료
    await sleep(POLL_INTERVAL_MS);
  }
}
