'use server'

import { datasetSchema } from '@/entities/dataset'
import { isTraceEvaluation, scorecardRecordSchema } from '@/entities/scorecard'
import { traceEventSchema, type TraceEvent } from '@/entities/trace'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

import type { CaseScoreEvidence, ScorecardCaseDetail } from '../model/case-view'

// The door to one case's heavy half — task body · each score's evidence · full error text · screenshot, plus
// the embedded trace for a case with no child run. The list draws none of those four, so it does not carry
// them: on a batch of hundreds that payload WAS the reason the first paint and every later interaction stalled.
//
// `occurrence` = the 0-based occurrence of that caseId in the record's original results order. A trialled
// batch has one result row per trial, so a first-match on caseId alone would show every trial the first
// trial's evidence.
export type CaseDetailResult =
  | { ok: true; detail: ScorecardCaseDetail; events?: TraceEvent[] }
  | { ok: false; error: string }

// os-use screenshot src: a base64 embed (dev) becomes a data URL, otherwise the offloaded object-storage
// URL. Neither present means there is none.
function osUseShotSrc(snapshot?: {
  screenshot?: string
  screenshotRef?: string
}): string | undefined {
  if (snapshot?.screenshot) return `data:image/png;base64,${snapshot.screenshot}`
  if (snapshot?.screenshotRef && /^https?:\/\//.test(snapshot.screenshotRef))
    return snapshot.screenshotRef
  return undefined
}

export async function getScorecardCaseAction(
  scorecardId: string,
  caseId: string,
  occurrence: number,
  // A case with a child run reads its trajectory from the ledger (several planes), so the embedded trace is
  // not needed then.
  withTrace: boolean
): Promise<CaseDetailResult> {
  const ctx = await authContext()
  try {
    const record = scorecardRecordSchema.parse(await controlPlane.getScorecard(ctx, scorecardId))
    const result = (record.scorecard?.results ?? []).filter((r) => r.caseId === caseId)[occurrence]

    // The task body belongs to the dataset — supplementary, so a failed read still leaves the rest of the
    // evidence standing (only the identity section drops). A trace evaluation has no dataset at all: its
    // reserved sentinel would 404.
    let task: string | undefined
    if (!isTraceEvaluation(record)) {
      task = await controlPlane
        .getDataset(ctx, record.dataset.id, record.dataset.version)
        .then((r) => datasetSchema.parse(r).cases.find((c) => c.id === caseId)?.task)
        .catch(() => undefined)
    }

    // Only the scores that HAVE evidence, each carrying which score it belongs to as two fields — a joined
    // key gives two different (grader, metric) pairs the same name (see model/case-view).
    const evidence: CaseScoreEvidence[] = (result?.scores ?? [])
      .filter((score) => score.detail !== undefined || score.reason !== undefined)
      .map((score) => ({
        graderId: score.graderId,
        metric: score.metric,
        ...(score.detail !== undefined ? { detail: score.detail } : {}),
        ...(score.reason !== undefined ? { reason: score.reason } : {}),
      }))

    const screenshotSrc = osUseShotSrc(result?.snapshot)
    const detail: ScorecardCaseDetail = {
      ...(task !== undefined ? { task } : {}),
      errors: (result?.trace ?? [])
        .filter(
          (e): e is typeof e & { message: string } =>
            e.kind === 'error' && typeof e.message === 'string'
        )
        .map((e) => e.message),
      ...(screenshotSrc !== undefined ? { screenshotSrc } : {}),
      evidence,
    }
    if (!withTrace) return { ok: true, detail }

    // The record's loose (passthrough) events are re-parsed one at a time through the contract lens
    // (entities/trace's strict traceEventSchema) — the same rule the run detail's toEvidence follows: a kind
    // this build does not know drops out of the evidence view instead of breaking the whole of it.
    const events: TraceEvent[] = []
    for (const event of result?.trace ?? []) {
      const parsed = traceEventSchema.safeParse(event)
      if (parsed.success) events.push(parsed.data)
    }
    return { ok: true, detail, events }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
