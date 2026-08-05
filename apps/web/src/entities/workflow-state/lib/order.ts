import { ISSUE_STATUSES, type IssueStatus } from '@/entities/issue'

// 보드의 자리들 — 팀이 컬럼을 붙일 수 있는 정규 상태. `regressed` 는 빠진다: 이슈는 해결이 무너져서 그리로
// 가지, 누가 카드를 끌어서 가지 않는다(docs/tracker.md).
export const WORKFLOW_COLUMN_STATUSES = ISSUE_STATUSES.filter(
  (status): status is Exclude<IssueStatus, 'regressed'> => status !== 'regressed'
)

const RANK = new Map<IssueStatus, number>(ISSUE_STATUSES.map((status, index) => [status, index]))

// 보드의 순서 — 먼저 정규 상태(워크플로가 흐르는 방향), 그 다음 팀이 정한 자리 안에서의 순서.
//
// 서버는 `position` 하나로만 정렬해 주는데, 새 컬럼은 보드 끝에 붙는다: 팀이 「검토 중」에 "QA 중"을 더하면
// 그 컬럼의 position 은 「취소됨」보다 뒤가 된다. 그래서 목록을 그대로 그리면 이슈의 상태 드롭다운에서 QA 가
// 취소됨 아래에 나타난다 — 설정 화면은 자리별로 묶어 보여주므로 두 화면이 서로 다른 순서를 말하게 된다.
// 순서를 정하는 규칙은 한 곳에만 있어야 해서, 상태를 늘어놓는 모든 화면이 이 함수를 지난다.
export function orderWorkflowStates<T extends { status: IssueStatus; position: number }>(
  states: readonly T[]
): T[] {
  return [...states].sort(
    (a, b) => (RANK.get(a.status) ?? 0) - (RANK.get(b.status) ?? 0) || a.position - b.position
  )
}
