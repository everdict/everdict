// The action is a `use server` module (safe from a client island); the LOADER is `server-only` and is
// exported from its own path so a client barrel import cannot reach it.
export { loadScorecardViewAction } from './api/load-scorecard-view'
export type { ScorecardView, ScorecardViewData, ScorecardViewGroup } from './model/view'
