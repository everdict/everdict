import type { IssueStatus } from './schema'

export type IssueStatusTone = 'neutral' | 'success' | 'danger' | 'warning' | 'info' | 'outline'

// The two verdicts the tracker exists to make visible: `done` reads as success, `regressed` as an alarm.
// Everything else is progress, not judgment.
const TONE: Record<IssueStatus, IssueStatusTone> = {
  backlog: 'outline',
  todo: 'neutral',
  in_progress: 'info',
  in_review: 'warning',
  done: 'success',
  cancelled: 'neutral',
  regressed: 'danger',
}

export function issueStatusTone(status: IssueStatus): IssueStatusTone {
  return TONE[status]
}
