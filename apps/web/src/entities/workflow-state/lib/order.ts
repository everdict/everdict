import { ISSUE_STATUSES, type IssueStatus } from '@/entities/issue'

const RANK = new Map<IssueStatus, number>(ISSUE_STATUSES.map((status, index) => [status, index]))

// The board's order — the canonical status first (the direction the workflow flows), then the order within the slot the workspace set.
//
// The server sorts by `position` alone, and a column a workspace added was appended at the board's end: an "in QA" column added beside
// "in review" has a position after "cancelled". So drawing the list as-is would put QA below cancelled in an issue's status dropdown.
// The rule that decides the order has to live in ONE place, so every screen that lays statuses out passes through this function.
export function orderWorkflowStates<T extends { status: IssueStatus; position: number }>(
  states: readonly T[]
): T[] {
  return [...states].sort(
    (a, b) => (RANK.get(a.status) ?? 0) - (RANK.get(b.status) ?? 0) || a.position - b.position
  )
}
