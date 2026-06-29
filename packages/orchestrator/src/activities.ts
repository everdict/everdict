import type { Dispatcher } from "@assay/backends";
import type { AgentJob, CaseResult } from "@assay/core";
import type { Activities } from "./types.js";

// 예약 발사 액티비티가 컨트롤플레인 internal 라우트를 호출할 설정(워커→API HTTP 브리지). 없으면 발사 액티비티 비활성.
export interface ScheduleActivityConfig {
  apiUrl: string; // 컨트롤플레인 베이스 URL(예: http://localhost:8787)
  internalToken: string; // /internal/** x-internal-token
}

// 액티비티는 비결정적·I/O 허용 영역 — 여기서 실제 백엔드로 라우팅/디스패치하고, 예약 발사는 internal 라우트로 브리지한다.
// 워커가 보유한 Dispatcher(Router 또는 용량인지 Scheduler)를 클로저로 받는다. schedule 미설정이면 발사 액티비티는 throw
// (스케줄 워크플로는 Temporal+API 가 설정됐을 때만 시작되므로 정상 경로에선 호출되지 않는다).
export function createActivities(dispatcher: Dispatcher, schedule?: ScheduleActivityConfig): Activities {
  return {
    dispatchCase(job: AgentJob): Promise<CaseResult> {
      return dispatcher.dispatch(job);
    },
    async fireScheduledScorecard(input: { scheduleId: string; tenant: string }): Promise<{ scorecardId: string }> {
      if (!schedule) throw new Error("schedule 액티비티가 설정되지 않았습니다(ASSAY_API_URL/ASSAY_INTERNAL_TOKEN).");
      const res = await fetch(
        `${schedule.apiUrl.replace(/\/$/, "")}/internal/schedules/${encodeURIComponent(input.scheduleId)}/fire`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-internal-token": schedule.internalToken },
          body: JSON.stringify({ tenant: input.tenant }),
        },
      );
      if (!res.ok) throw new Error(`예약 발사 실패: ${res.status} ${await res.text()}`);
      const json = (await res.json()) as { scorecardId?: unknown };
      if (typeof json.scorecardId !== "string") throw new Error("fire 응답에 scorecardId 가 없습니다.");
      return { scorecardId: json.scorecardId };
    },
    async scheduledScorecardStatus(scorecardId: string): Promise<string | null> {
      if (!schedule) throw new Error("schedule 액티비티가 설정되지 않았습니다(ASSAY_API_URL/ASSAY_INTERNAL_TOKEN).");
      const res = await fetch(
        `${schedule.apiUrl.replace(/\/$/, "")}/internal/schedules/scorecard-status/${encodeURIComponent(scorecardId)}`,
        { headers: { "x-internal-token": schedule.internalToken } },
      );
      if (!res.ok) throw new Error(`예약 스코어카드 status 실패: ${res.status}`);
      const json = (await res.json()) as { status?: unknown };
      return typeof json.status === "string" ? json.status : null;
    },
  };
}
