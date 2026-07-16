// Dataset → the harnesses evaluated with that dataset. A dataset is harness-agnostic, so the actual relation
// only surfaces in runs (scorecards) — to show "what was run with this dataset" in the list/detail, we derive it from scorecards.
export interface DatasetRelation {
  harnesses: string[] // distinct harness ids that still exist, evaluated with this dataset (in order of appearance)
  scorecards: number // number of scorecard runs that referenced this dataset
  lastRunAt?: string // most recent run timestamp (ISO)
  lastStatus?: string // status of the most recent run (queued|running|succeeded|failed)
  lastPassRate?: number | null // representative pass rate of the most recent run (on success)
  lastMean?: number | null // representative mean of the most recent run
}

// The minimal scorecard shape buildDatasetRelations takes (a subset of the full ScorecardRecord).
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

// Representative metric — the first metric with a pass rate, else the first metric (the basis for the list's "recent result").
function primaryMetric(sc: ScorecardLike): MetricLike | undefined {
  return sc.summary?.find((m) => m.passRate != null) ?? sc.summary?.[0]
}

// liveHarnessIds — the set of harness ids that currently exist and are visible to the viewer (from GET /harnesses,
// which excludes soft-deleted tombstones). The harness chips link to /harnesses/:id, so a deleted harness would be a
// dead link; when the set is given, only its ids surface as chips. The scorecard count / last-run stay untouched —
// the dataset was genuinely evaluated even if the harness was later retired. Omit the set to keep every harness.
export function buildDatasetRelations(
  scorecards: ScorecardLike[],
  liveHarnessIds?: ReadonlySet<string>
): Record<string, DatasetRelation> {
  const out: Record<string, DatasetRelation> = {}
  for (const sc of scorecards) {
    const id = sc.dataset.id
    const rel = (out[id] ??= { harnesses: [], scorecards: 0 })
    rel.scorecards += 1
    const harnessLive = liveHarnessIds === undefined || liveHarnessIds.has(sc.harness.id)
    if (harnessLive && !rel.harnesses.includes(sc.harness.id)) rel.harnesses.push(sc.harness.id)
    // Most recent run: along with updating the timestamp, capture the status·representative score (recent result) from that run too.
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
