import type { ListDisplay, ListViewSpec } from '@/shared/lib/list-view'

// The axes of one batch's case list. Unlike the other four (harness · dataset · judge · scorecard) this is
// not a workspace collection but a SUB-LIST inside one scorecard — and the rule that a resource declares its
// axes once, beside itself, is the same, so that the toolbar grammar (search · filter · display) stands as
// the identical row here too.
//
// The axes were chosen from what people actually ask on a batch of hundreds:
//  · verdict  — the failures only. It is this list's first question, and the job the old all/failed tabs did
//               (two links, each re-rendering the whole force-dynamic route).
//  · failedBy — what knocked it down. On 500 cases the real unit of work is "the ones judge correctness failed".
//  · tag·env  — the subsets the dataset already carved out.
// There is deliberately no "grader that scored it" axis: in a batch where every case is graded by the same
// graders that axis always offers exactly one option matching everything, which makes it decoration rather
// than an axis (the same rule `facetOptionsOf` applies to values).
export const CASE_FACETS = ['verdict', 'failedBy', 'tag', 'env'] as const
// Verdict is the only grouping: it is a closed vocabulary, and folding "470 passed" away is the thing people
// do most often in front of hundreds of rows.
export const CASE_GROUPINGS = ['none', 'verdict'] as const
export const CASE_ORDERS = ['failuresFirst', 'caseId'] as const

// The first screen looks the way it always did — ungrouped, failures first.
export const DEFAULT_CASE_DISPLAY: ListDisplay = { grouping: 'none', order: 'failuresFirst' }

export type CaseVerdictKey = 'fail' | 'skip' | 'pass'

// Verdict → the axis value. A case with no verdict is a third value, not a pass, and that fact must not
// disappear in the filter either: "neither" is a bucket people go looking for.
export function caseVerdictKey(verdict: boolean | undefined): CaseVerdictKey {
  return verdict === false ? 'fail' : verdict === undefined ? 'skip' : 'pass'
}

const VERDICT_ORDER: readonly string[] = ['fail', 'skip', 'pass']

// Only the facts the axes read. The row view (widgets/scorecard-cases) satisfies this structurally — the
// heavy things (task body, score rationale, full error text, screenshot) never ride a row, so no axis asks
// for them.
export interface ScorecardCaseFacts {
  caseId: string
  trial?: number
  verdict?: boolean
  scores: readonly { graderId: string; metric: string; pass?: boolean }[]
  taskSummary?: string
  errorSummary?: string
  tags?: readonly string[]
  envKind?: string
}

// What knocked this case down — `graderId:metric`, and **only on a case the verdict failed**. A metric that
// failed inside a passing case is one the verdict authority already decided not to count; counting it here
// would make this filter say something different from the verdict.
export function caseFailedBy(item: ScorecardCaseFacts): string[] {
  if (item.verdict !== false) return []
  return item.scores.filter((s) => s.pass === false).map((s) => `${s.graderId}:${s.metric}`)
}

export const scorecardCaseListSpec: ListViewSpec<ScorecardCaseFacts> = {
  facetValues: (item, facet) => {
    switch (facet) {
      case 'verdict':
        return [caseVerdictKey(item.verdict)]
      case 'failedBy':
        return caseFailedBy(item)
      case 'tag':
        return item.tags ?? []
      case 'env':
        return item.envKind === undefined ? [] : [item.envKind]
      default:
        return []
    }
  },
  // One search sweeps the case id, what the case was (its task line), how it died (its error line) and the
  // metrics it was scored on. On hundreds of rows, the failure message is often the fastest way in.
  searchText: (item) =>
    [
      item.caseId,
      item.taskSummary ?? '',
      item.errorSummary ?? '',
      (item.tags ?? []).join(' '),
      item.scores.map((s) => s.metric).join(' '),
    ].join(' '),
  groupKey: (item, grouping) => (grouping === 'verdict' ? caseVerdictKey(item.verdict) : null),
  compare: (a, b, order) => {
    if (order === 'caseId') return compareCaseId(a, b)
    const weight =
      VERDICT_ORDER.indexOf(caseVerdictKey(a.verdict)) -
      VERDICT_ORDER.indexOf(caseVerdictKey(b.verdict))
    return weight !== 0 ? weight : compareCaseId(a, b)
  },
  // The verdict groups' order IS the vocabulary — failures have to stand above passes for this screen to
  // answer "what went wrong" first.
  groupOrder: (grouping) => (grouping === 'verdict' ? VERDICT_ORDER : undefined),
}

// One caseId's trials stay together in run order, whatever the ordering — trial 1 · 2 · 3 of a case read as
// one thing.
function compareCaseId(a: ScorecardCaseFacts, b: ScorecardCaseFacts): number {
  const byId = a.caseId.localeCompare(b.caseId)
  return byId !== 0 ? byId : (a.trial ?? 0) - (b.trial ?? 0)
}
