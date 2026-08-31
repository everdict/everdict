import 'server-only'

// The server-side entry: the loader the page calls for its first paint. Kept out of the package barrel
// because a client island imports that barrel for the action and the types.
export { loadScorecardViewData, scorecardQueryOf } from './api/scorecard-view-data'
