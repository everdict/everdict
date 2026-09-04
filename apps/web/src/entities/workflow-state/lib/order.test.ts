import { describe, expect, it } from 'vitest'

import { orderWorkflowStates, WORKFLOW_COLUMN_STATUSES } from './order'

// The board's order has two steps: the direction the workflow flows (the canonical status) first, then the order the team set within that slot.
describe('the board order — canonical position first, the team ordering inside it', () => {
  it('sorts a state after every state of an earlier canonical status, whatever its position is', () => {
    // A new column is appended by the server at the board's end (position = max+1) — a team adding "in QA" to "in review" gives it a value
    // GREATER than "cancelled". Sorted by position alone, QA appears below cancelled.
    const states = [
      { id: 'a', status: 'backlog' as const, position: 0 },
      { id: 'b', status: 'cancelled' as const, position: 5 },
      { id: 'c', status: 'in_review' as const, position: 6 },
      { id: 'd', status: 'done' as const, position: 4 },
    ]
    expect(orderWorkflowStates(states).map((s) => s.id)).toEqual(['a', 'c', 'd', 'b'])
  })

  it('keeps the team ordering among states that share a canonical status', () => {
    const states = [
      { id: 'qa', status: 'in_review' as const, position: 6 },
      { id: 'review', status: 'in_review' as const, position: 3 },
    ]
    expect(orderWorkflowStates(states).map((s) => s.id)).toEqual(['review', 'qa'])
  })

  it('does not mutate the list it was handed', () => {
    const states = [
      { id: 'late', status: 'done' as const, position: 9 },
      { id: 'early', status: 'todo' as const, position: 1 },
    ]
    orderWorkflowStates(states)
    expect(states.map((s) => s.id)).toEqual(['late', 'early'])
  })

  // `regressed` cannot be a column — an issue goes there because its resolution broke, not because somebody dragged a card.
  it('offers every canonical status as a column except regressed', () => {
    expect(WORKFLOW_COLUMN_STATUSES).toEqual([
      'backlog',
      'todo',
      'in_progress',
      'in_review',
      'done',
      'cancelled',
    ])
  })
})
