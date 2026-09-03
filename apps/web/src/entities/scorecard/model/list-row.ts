import type { ScorecardRecord, ScorecardStatus } from './schema'

// What the scorecards LIST carries per batch — measured, not guessed. The list is a client island, so every
// field of every record it is handed is serialized into the page a second time as flight data, and the list
// draws a small fraction of them: a completed CI-triggered batch arrives at ~1.8KB (~4KB when it ran a
// SUBSET, because `subset.ids` names every case it selected) while the card reads ~0.9KB of that. The rest —
// `subset.ids`, `models.observed`, every metric past the third, `verdictPolicy`, `manifest`, `tenant`,
// `requested`, `headlinePassRate` — is not drawn by a row, and it is multiplied by a collection that only
// grows. At 1000 batches that is 1.7–3.9MB of payload for 0.9MB of screen.
//
// So the server component projects, and the island (plus this resource's axes) reads THIS. The rule for
// adding a field is the one that made the type: a row carries what a row draws, or what deciding which rows
// to draw requires (the facet axes, the search text, the delete gate).
export interface ScorecardRow {
  id: string
  dataset: { id: string; version: string }
  harness: { id: string; version: string }
  status: ScorecardStatus
  // The chips the card stands: the first three of the persisted summary, values included.
  metrics: { metric: string; mean?: number; passRate?: number; unmeasured?: number }[]
  // EVERY metric's name, because a judge metric only reads correctly beside its siblings
  // (`fmtMetricLabel` decides judge-overall vs judge-criterion from them) — and the count behind the "+N".
  metricNames: string[]
  model?: string
  // The card shows one judge model and a "+N"; the rest never reach the screen.
  judgeModel?: string
  judgeModelCount: number
  // Exactly what OriginChip draws — never `ref`, `runUrl` or `pinOverrides` (a pinned digest is 71 chars).
  origin?: { source: string; repo?: string; sha?: string; prNumber?: number }
  createdBy?: string
  teamId?: string
  runtime?: string
  // The "{selected}/{total}" chip. `ids` and `tags` are the reason a subset row was twice the size of any other.
  subset?: { total: number; selected: number }
  createdAt: string
  updatedAt: string
}

export function toScorecardRow(record: ScorecardRecord): ScorecardRow {
  const summary = record.summary ?? []
  const judgeModels = record.judgeModels ?? []
  return {
    id: record.id,
    dataset: record.dataset,
    harness: record.harness,
    status: record.status,
    metrics: summary.slice(0, 3).map((m) => ({
      metric: m.metric,
      ...(m.mean !== undefined ? { mean: m.mean } : {}),
      ...(m.passRate !== undefined ? { passRate: m.passRate } : {}),
      ...(m.unmeasured !== undefined ? { unmeasured: m.unmeasured } : {}),
    })),
    metricNames: summary.map((m) => m.metric),
    ...(record.models?.primary !== undefined ? { model: record.models.primary } : {}),
    ...(judgeModels[0] !== undefined ? { judgeModel: judgeModels[0] } : {}),
    judgeModelCount: judgeModels.length,
    ...(record.origin !== undefined
      ? {
          origin: {
            source: record.origin.source,
            ...(record.origin.repo !== undefined ? { repo: record.origin.repo } : {}),
            ...(record.origin.sha !== undefined ? { sha: record.origin.sha } : {}),
            ...(record.origin.prNumber !== undefined ? { prNumber: record.origin.prNumber } : {}),
          },
        }
      : {}),
    ...(record.createdBy !== undefined ? { createdBy: record.createdBy } : {}),
    ...(record.runtime !== undefined ? { runtime: record.runtime } : {}),
    ...(record.subset !== undefined
      ? { subset: { total: record.subset.total, selected: record.subset.selected } }
      : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}
