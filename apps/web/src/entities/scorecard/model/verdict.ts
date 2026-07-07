import type { ScorecardRecord } from './schema'

// Case pass verdict — authority order (mirror of the control plane @everdict/suite caseVerdict): ground-truth (state/tests_pass) >
// objective (answer_match/url_matches/dom_contains) > model opinion (judge). The judge decides only when objective/ground-truth is absent
// (a VLM judge cannot override state — like OSWorld file saving).
const AUTHORITATIVE = ['state', 'tests_pass']
const OBJECTIVE = ['answer_match', 'url_matches', 'dom_contains']

type Score = { metric: string; pass?: boolean }

export function caseVerdict(scores: Score[]): boolean | undefined {
  const by = new Map(scores.map((s) => [s.metric, s]))
  for (const m of AUTHORITATIVE) {
    const s = by.get(m)
    if (s?.pass !== undefined) return s.pass
  }
  const objs = OBJECTIVE.map((m) => by.get(m)).filter((s): s is Score => s?.pass !== undefined)
  if (objs.length > 0) return objs.every((s) => s.pass)
  const judge = by.get('judge')
  if (judge?.pass !== undefined) return judge.pass
  const withPass = scores.filter((s) => s.pass !== undefined)
  return withPass.length > 0 ? withPass.every((s) => s.pass) : undefined
}

// Classify a scorecard into a track (desktop/web/other) — a dataset·harness id heuristic.
export function trackOf(rec: ScorecardRecord): 'desktop' | 'web' | 'other' {
  const s = `${rec.dataset.id} ${rec.harness.id}`.toLowerCase()
  if (/osworld|desktop|os-use/.test(s)) return 'desktop'
  if (/webvoyager|browser|web/.test(s)) return 'web'
  return 'other'
}

// Case-level pass for the scorecard (authority order). {0,0} if there are no results.
export function casePass(rec: ScorecardRecord): { pass: number; total: number } {
  let pass = 0
  let total = 0
  for (const r of rec.scorecard?.results ?? []) {
    const v = caseVerdict(r.scores)
    if (v === undefined) continue
    total++
    if (v) pass++
  }
  return { pass, total }
}
