// 데이터셋 → 그 데이터셋으로 평가된 하니스들. 데이터셋은 하니스 무관이라 실제 연관은
// 실행(스코어카드)에서만 드러난다 — 목록/상세에서 "이 데이터셋으로 뭘 돌렸나"를 보여주려고 스코어카드에서 도출한다.
export interface DatasetRelation {
  harnesses: string[] // 이 데이터셋으로 평가된 서로 다른 하니스 id(등장 순)
  scorecards: number // 이 데이터셋을 참조한 스코어카드 실행 수
  lastRunAt?: string // 가장 최근 실행 시각(ISO)
  lastStatus?: string // 가장 최근 실행의 상태(queued|running|succeeded|failed)
  lastPassRate?: number | null // 가장 최근 실행의 대표 통과율(성공 시)
  lastMean?: number | null // 가장 최근 실행의 대표 평균
}

// buildDatasetRelations 가 받는 최소 스코어카드 모양(전체 ScorecardRecord 의 부분집합).
interface MetricLike {
  metric: string
  mean: number
  passRate?: number
}
interface ScorecardLike {
  dataset: { id: string }
  harness: { id: string }
  createdAt: string
  status?: string
  summary?: MetricLike[]
}

// 대표 메트릭 — 통과율이 있는 첫 메트릭, 없으면 첫 메트릭(목록의 "최근 결과" 기준).
function primaryMetric(sc: ScorecardLike): MetricLike | undefined {
  return sc.summary?.find((m) => m.passRate != null) ?? sc.summary?.[0]
}

export function buildDatasetRelations(
  scorecards: ScorecardLike[]
): Record<string, DatasetRelation> {
  const out: Record<string, DatasetRelation> = {}
  for (const sc of scorecards) {
    const id = sc.dataset.id
    const rel = (out[id] ??= { harnesses: [], scorecards: 0 })
    rel.scorecards += 1
    if (!rel.harnesses.includes(sc.harness.id)) rel.harnesses.push(sc.harness.id)
    // 가장 최근 실행: 시각 갱신과 함께 상태·대표 점수(최근 결과)도 그 실행 것으로 캡처.
    if (rel.lastRunAt === undefined || sc.createdAt > rel.lastRunAt) {
      rel.lastRunAt = sc.createdAt
      rel.lastStatus = sc.status
      const m = primaryMetric(sc)
      rel.lastPassRate = m?.passRate ?? null
      rel.lastMean = m?.mean ?? null
    }
  }
  return out
}
