import { ISSUE_STATUSES, type IssueStatus } from '@/entities/issue'

// The board's slots — the canonical statuses a team can attach columns to. `regressed` is excluded: an issue goes there because its resolution
// broke, not because somebody dragged a card (docs/tracker.md).
export const WORKFLOW_COLUMN_STATUSES = ISSUE_STATUSES.filter(
  (status): status is Exclude<IssueStatus, 'regressed'> => status !== 'regressed'
)

const RANK = new Map<IssueStatus, number>(ISSUE_STATUSES.map((status, index) => [status, index]))

// The board's order — the canonical status first (the direction the workflow flows), then the order within the slot the team set.
//
// The server sorts by `position` alone, and a new column is appended at the board's end: a team adding "in QA" to "in review" gives that column
// a position after "cancelled". So drawing the list as-is makes QA appear below cancelled in an issue's status dropdown — while the settings
// screen groups by slot, so the two screens would state different orders.
// The rule that decides the order has to live in ONE place, so every screen that lays statuses out passes through this function.
export function orderWorkflowStates<T extends { status: IssueStatus; position: number }>(
  states: readonly T[]
): T[] {
  return [...states].sort(
    (a, b) => (RANK.get(a.status) ?? 0) - (RANK.get(b.status) ?? 0) || a.position - b.position
  )
}
