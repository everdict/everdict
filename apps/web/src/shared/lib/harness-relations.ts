// Harness → the benchmarks (datasets) evaluated with that harness + recent run results. A harness is dataset-agnostic, so
// the actual relation only surfaces in runs (scorecards) — we derive "what was run with this harness / recent result" for the list from scorecards.
export interface HarnessRelation {
  datasets: string[] // distinct dataset (benchmark) ids evaluated with this harness (in order of appearance)
  scorecards: number // number of scorecard runs this harness appeared in
  lastRunAt?: string // most recent run timestamp (ISO)
  lastStatus?: string // status of the most recent run (queued|running|succeeded|failed)
  lastPassRate?: number | null // representative pass rate of the most recent run (on success)
  lastMean?: number | null // representative mean of the most recent run
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
