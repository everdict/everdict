import type { AgentJob, CaseResult } from "@assay/core";

// 워크플로가 호출하는 액티비티 시그니처(순수 타입 — 워크플로 번들에 안전하게 import 됨).
export interface Activities {
  dispatchCase(job: AgentJob): Promise<CaseResult>;
  // 예약 발사 — 컨트롤플레인 internal 라우트로 스코어카드 submit(워커엔 ScorecardService 가 없어 HTTP 브리지).
  fireScheduledScorecard(input: { scheduleId: string; tenant: string }): Promise<{ scorecardId: string }>;
  // 발사한 스코어카드 status 폴링(워크플로 poll-to-terminal — overlap 정책이 의미를 갖게).
  scheduledScorecardStatus(scorecardId: string): Promise<string | null>;
}
