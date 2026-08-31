'use server'

import type { ScorecardRow } from '@/entities/scorecard'
import { authContext } from '@/shared/auth/principal'

import type { ScorecardView, ScorecardViewData } from '../model/view'
import { loadScorecardViewData } from './scorecard-view-data'

// The view changed — a filter, the search, the grouping — or the reader asked for the next page. ONE action
// returning ONLY the list's data, because the alternative is what this screen used to do: a route re-render
// that read the members, the teams and the runner roster again to change which batches are drawn, while the
// screen sat as a skeleton.
export async function loadScorecardViewAction(
  view: ScorecardView,
  more?: { rows: ScorecardRow[]; before: { createdAt: string; id: string } }
): Promise<ScorecardViewData> {
  const ctx = await authContext()
  return loadScorecardViewData(ctx, view, more)
}
