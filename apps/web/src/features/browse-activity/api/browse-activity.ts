'use server'

import { runsSchema, type Run, type RunRowData } from '@/entities/run'
import { scorecardsSchema, type ScorecardRecord, type ScorecardStatus } from '@/entities/scorecard'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// A scorecard batch collapsed to a single feed row — sourced from the lightweight scorecards list (no child runs), so
// the activity console never pulls every case up-front. Cases load on demand when the row is expanded.
export interface BatchSummary {
  id: string
  harness: { id: string; version: string }
  status: ScorecardStatus
  // Best-effort case count for the header badge (subset selection or the widest metric's scored count). Undefined = unknown.
  count?: number
  updatedAt: string
}

// One top-level unit of the "all executions" feed: a standalone run, or a scorecard batch grouping its cases. Pagination
// happens at THIS granularity so a batch's cases are never split across pages (the grouping stays intact).
export type ActivityBlock =
  | { kind: 'run'; run: RunRowData; ts: number }
  | { kind: 'batch'; batch: BatchSummary; ts: number }

export type ActivityFeedResult =
  | { ok: true; blocks: ActivityBlock[] }
  | { ok: false; error: string }
export type BatchCasesResult = { ok: true; runs: RunRowData[] } | { ok: false; error: string }

// Strip a full run record to the fields a row renders — keeps the client payload small (no result/trace jsonb).
function toRow(r: Run): RunRowData {
  return {
    id: r.id,
    harness: r.harness,
    caseId: r.caseId,
    status: r.status,
    trigger: r.trigger,
    usage: r.usage,
    updatedAt: r.updatedAt,
  }
}

// Best-effort case count from the lightweight summary: a subset run reports its selected count; otherwise take the widest
// metric's scored count. Absent on legacy/aggregate-less records → no badge (the real count shows once expanded).
function batchCount(sc: ScorecardRecord): number | undefined {
  if (sc.subset) return sc.subset.selected
  if (sc.summary && sc.summary.length > 0) return Math.max(...sc.summary.map((m) => m.count))
  return undefined
}

// The whole top-level activity feed (standalone runs + scorecard batches), recency-ordered, in ONE lightweight call:
// scorecards come from their summary list (no cases) and standalone runs are stripped to row fields. The client
// paginates this array locally and lazy-loads a batch's cases on expand — so the old "load every child run" flood is
// gone. authZ (runs:read / scorecards:read) is enforced by the control plane.
export async function listActivityAction(): Promise<ActivityFeedResult> {
  const ctx = await authContext()
  try {
    const [runsRaw, scRaw] = await Promise.all([
      controlPlane.listRuns(ctx), // default = standalone (parentless) runs only; children arrive via their batch
      controlPlane.listScorecards(ctx),
    ])
    const standalone = runsSchema.parse(runsRaw)
    const scorecards = scorecardsSchema.parse(scRaw)
    const blocks: ActivityBlock[] = [
      ...standalone.map(
        (r): ActivityBlock => ({ kind: 'run', run: toRow(r), ts: Date.parse(r.updatedAt) })
      ),
      ...scorecards.map(
        (s): ActivityBlock => ({
          kind: 'batch',
          batch: {
            id: s.id,
            harness: s.harness,
            status: s.status,
            count: batchCount(s),
            updatedAt: s.updatedAt,
          },
          ts: Date.parse(s.updatedAt),
        })
      ),
    ].sort((a, b) => b.ts - a.ts)
    return { ok: true, blocks }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// One batch's cases (child runs), stripped to row fields — fetched only when the user expands that batch.
export async function listBatchCasesAction(scorecardId: string): Promise<BatchCasesResult> {
  const ctx = await authContext()
  try {
    const children = runsSchema.parse(await controlPlane.listRuns(ctx, { scorecardId }))
    return { ok: true, runs: children.map(toRow) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
