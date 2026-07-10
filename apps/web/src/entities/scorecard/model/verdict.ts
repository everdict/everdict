import type { ScorecardRecord } from './schema'

// The case-verdict authority ranking and its casePass rollup are SERVED by the control plane
// (per-case `verdict` + record `casePass`, computed from @everdict/domain rules at serve time) —
// the client-side mirrors were deleted in re-architecture P1g. Only the UI-local grouping
// heuristic below stays: it has no server counterpart (pure display taxonomy).

// Classify a scorecard into a track (desktop/web/other) — a dataset·harness id heuristic.
export function trackOf(rec: ScorecardRecord): 'desktop' | 'web' | 'other' {
  const s = `${rec.dataset.id} ${rec.harness.id}`.toLowerCase()
  if (/osworld|desktop|os-use/.test(s)) return 'desktop'
  if (/webvoyager|browser|web/.test(s)) return 'web'
  return 'other'
}
