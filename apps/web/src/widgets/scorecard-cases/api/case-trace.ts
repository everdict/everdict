'use server'

import { scorecardRecordSchema } from '@/entities/scorecard'
import { traceEventSchema, type TraceEvent } from '@/entities/trace'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export type CaseTraceResult = { ok: true; events: TraceEvent[] } | { ok: false; error: string }

// 자식 run 이 없는 케이스(레거시·ingest)의 실행 증거 — 스코어카드 레코드에 임베디드된 케이스 트레이스를
// 요청 시점에 다시 읽는다. 목록이 모든 케이스의 전체 트레이스를 클라이언트로 실어 나르지 않기 위한 문:
// 다이얼로그가 열릴 때 그 케이스 것만 가져온다. 레코드의 느슨한(passthrough) 이벤트를 계약 렌즈
// (entities/trace 의 strict traceEventSchema)로 이벤트 단위 재파싱한다 — run 상세의 toEvidence 와 같은
// 규칙: 이 빌드가 모르는 kind 는 증거 뷰에서 빠질 뿐, 전체를 깨뜨리지 않는다.
// `occurrence` = 원본 results 순서 기준 그 caseId 의 0-기반 등장 순번 — 트라이얼 배치에서 트라이얼마다
// 결과 행이 따로 있으므로, caseId 하나로 first-match 하면 모든 트라이얼이 첫 트라이얼의 트레이스를 보게 된다.
export async function getScorecardCaseTraceAction(
  scorecardId: string,
  caseId: string,
  occurrence: number
): Promise<CaseTraceResult> {
  const ctx = await authContext()
  try {
    const record = scorecardRecordSchema.parse(await controlPlane.getScorecard(ctx, scorecardId))
    const result = (record.scorecard?.results ?? []).filter((r) => r.caseId === caseId)[occurrence]
    const events: TraceEvent[] = []
    for (const event of result?.trace ?? []) {
      const parsed = traceEventSchema.safeParse(event)
      if (parsed.success) events.push(parsed.data)
    }
    return { ok: true, events }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
