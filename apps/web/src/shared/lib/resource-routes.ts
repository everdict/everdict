// The one table saying which COLLECTION segment owns which SINGULAR one.
//
// Linear's spelling: `/{workspace}/scorecards` is the list, `/{workspace}/scorecard/{id}` is one scorecard. Two
// addresses, and three separate things need to agree on the pairing — the redirects that keep old links alive
// (`next.config.ts`), the sidebar's "which row is active" (a detail page belongs to its collection's row), and
// the team path reader. When each derived the pairing itself, a detail page simply lit no nav row at all.
//
// Deliberately dependency-free: `next.config.ts` imports this module while Next is still booting, so anything
// that pulls in app code would break config loading.

export interface DetailRoute {
  // The collection's segment — the list page, and the nav row.
  plural: string
  // The segment that addresses ONE of them.
  singular: string
  // Screens that live under the COLLECTION and are named rather than identified. `…/scorecards/new` is the
  // collection's own screen, so it must never be read as an id and redirected to `/scorecard/new`.
  reserved: string[]
}

export const DETAIL_ROUTES: DetailRoute[] = [
  { plural: 'issues', singular: 'issue', reserved: [] },
  { plural: 'projects', singular: 'project', reserved: [] },
  { plural: 'initiatives', singular: 'initiative', reserved: [] },
  { plural: 'cycles', singular: 'cycle', reserved: [] },
  { plural: 'datasets', singular: 'dataset', reserved: ['new', 'import'] },
  { plural: 'harnesses', singular: 'harness', reserved: ['new'] },
  { plural: 'judges', singular: 'judge', reserved: ['new'] },
  { plural: 'rubrics', singular: 'rubric', reserved: ['new'] },
  { plural: 'runs', singular: 'run', reserved: ['new'] },
  // `self` is deliberately NOT reserved: `/runtimes/self/{id}` carries through to `/runtime/self/{id}`.
  { plural: 'runtimes', singular: 'runtime', reserved: ['new'] },
  { plural: 'schedules', singular: 'schedule', reserved: ['new'] },
  {
    plural: 'scorecards',
    singular: 'scorecard',
    reserved: ['new', 'analyze', 'compare', 'trend', 'leaderboard', 'ingest', 'by-harness'],
  },
  { plural: 'skills', singular: 'skill', reserved: [] },
  { plural: 'views', singular: 'view', reserved: [] },
  { plural: 'teams', singular: 'team', reserved: [] },
  { plural: 'tools', singular: 'tool', reserved: [] },
]

// The segment that addresses one of these — `scorecards` → `scorecard`.
export function singularSegment(plural: string): string | undefined {
  return DETAIL_ROUTES.find((route) => route.plural === plural)?.singular
}

// The collection a singular segment belongs to — `scorecard` → `scorecards`. This is the direction the nav and
// the team path reader need: they hold a collection and are asked about an address that names one thing.
export function pluralSegment(singular: string): string | undefined {
  return DETAIL_ROUTES.find((route) => route.singular === singular)?.plural
}
