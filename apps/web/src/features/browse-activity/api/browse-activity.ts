'use server'

import { runListSchema, runsSchema, type RunRowData } from '@/entities/run'
import { scorecardsSchema } from '@/entities/scorecard'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

import { buildActivityBlocks, toRow, type ActivityBlock } from '../model/blocks'

// Feed/block shapes live in ../model/blocks (pure, unit-tested); a 'use server' module may export only actions.
export type { ActivityBlock, BatchSummary, SessionSummary } from '../model/blocks'

export type ActivityFeedResult =
  | { ok: true; blocks: ActivityBlock[] }
  | { ok: false; error: string }
export type BatchCasesResult = { ok: true; runs: RunRowData[] } | { ok: false; error: string }

// The whole top-level activity feed (standalone runs + scorecard batches + agent conversations), recency-ordered,
// in ONE lightweight call: scorecards come from their summary list (no cases), standalone runs are stripped to row
// fields, and an agent conversation's turns fold under one session block (they arrived with the standalone list, so
// expanding one costs nothing). The client paginates this array locally and lazy-loads a batch's cases on expand —
// so the old "load every child run" flood is gone. authZ (runs:read / scorecards:read) is enforced by the control plane.
export async function listActivityAction(): Promise<ActivityFeedResult> {
  const ctx = await authContext()
  try {
    // ── A FEED IS A PAGE (perf review) ───────────────────────────────────────────────────────────
    //
    // Both halves used to be unbounded: every standalone run the workspace had ever executed, and every
    // scorecard it had ever produced, fetched on every open of this screen and then paginated IN THE
    // BROWSER. The client's own comment above says the "load every child run" flood is gone — this was the
    // same flood one level up. `/runs` now carries a server-side page size of its own; the scorecard half
    // says its depth here, so the two agree about how far back the feed reaches.
    const [runsRaw, scRaw] = await Promise.all([
      controlPlane.listRuns(ctx, { limit: ACTIVITY_DEPTH }), // default = standalone (parentless) runs only; children arrive via their batch
      controlPlane.listScorecards(ctx, { limit: ACTIVITY_DEPTH }),
    ])
    return {
      ok: true,
      blocks: buildActivityBlocks(runsSchema.parse(runsRaw), scorecardsSchema.parse(scRaw)),
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// How far back the feed reaches. Recency-ordered, so this is depth rather than completeness — somebody
// looking further back is navigating (the scorecard list, a run's page), not scanning a feed.
const ACTIVITY_DEPTH = 200

// One batch's cases (child runs), stripped to row fields — fetched only when the user expands that batch.
export async function listBatchCasesAction(scorecardId: string): Promise<BatchCasesResult> {
  const ctx = await authContext()
  try {
    // runListSchema, not runsSchema: a batch's children carry the receipt's `canonical` verdict, and the plain
    // run schema strips it — every retried case would then look like it had one attempt.
    const children = runListSchema.parse(await controlPlane.listRuns(ctx, { scorecardId }))
    return { ok: true, runs: children.map(toRow) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
