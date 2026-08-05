import { describe, expect, it } from 'vitest'

import { orderWorkflowStates, WORKFLOW_COLUMN_STATUSES } from './order'

// 보드의 순서는 두 단계다: 워크플로가 흐르는 방향(정규 상태)이 먼저, 그 자리 안에서 팀이 정한 순서가 다음.
describe('the board order — canonical position first, the team ordering inside it', () => {
  it('sorts a state after every state of an earlier canonical status, whatever its position is', () => {
    // 새 컬럼은 서버에서 보드 끝(position = max+1)에 붙는다 — 팀이 「검토 중」에 "QA 중"을 더하면 그 값은
    // 「취소됨」보다 크다. position 만으로 정렬하면 QA 가 취소됨 아래에 나타난다.
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

  // `regressed` 는 컬럼이 될 수 없다 — 이슈는 해결이 무너져서 그리로 가지, 누가 카드를 끌어서 가지 않는다.
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
