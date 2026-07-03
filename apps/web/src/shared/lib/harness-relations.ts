// 하니스 → 그 하니스로 평가한 벤치마크(데이터셋)들 + 최근 실행 결과. 하니스는 데이터셋 무관이라
// 실제 연관은 실행(스코어카드)에서만 드러난다 — 목록에서 "이 하니스로 뭘 돌렸나 / 최근 결과"를 스코어카드에서 도출한다.
export interface HarnessRelation {
  datasets: string[] // 이 하니스로 평가된 서로 다른 데이터셋(벤치마크) id(등장 순)
  scorecards: number // 이 하니스가 등장한 스코어카드 실행 수
  lastRunAt?: string // 가장 최근 실행 시각(ISO)
  lastStatus?: string // 가장 최근 실행의 상태(queued|running|succeeded|failed)
  lastPassRate?: number | null // 가장 최근 실행의 대표 통과율(성공 시)
  lastMean?: number | null // 가장 최근 실행의 대표 평균
}

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

function primaryMetric(sc: ScorecardLike): MetricLike | undefined {
  return sc.summary?.find((m) => m.passRate != null) ?? sc.summary?.[0]
}

export function buildHarnessRelations(
  scorecards: ScorecardLike[]
): Record<string, HarnessRelation> {
  const out: Record<string, HarnessRelation> = {}
  for (const sc of scorecards) {
    const id = sc.harness.id
    const rel = (out[id] ??= { datasets: [], scorecards: 0 })
    rel.scorecards += 1
    if (!rel.datasets.includes(sc.dataset.id)) rel.datasets.push(sc.dataset.id)
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
