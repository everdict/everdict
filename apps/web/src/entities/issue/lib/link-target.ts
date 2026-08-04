import type { IssueLinkType } from '../model/schema'

// 링크가 가리키는 곳. 링크는 검증하지 않는 포인터라 대상이 404 일 수 있다 — 그게 "존재하기 전(또는 후)의
// 자산도 참조할 수 있다"의 대가다. 링크를 그리는 화면(속성 패널·이력)이 같은 주소를 쓰도록 한 곳에 둔다.
// Each entry addresses ONE thing, so each is the singular segment — the collection's plural (`/harnesses`) is a
// different address holding a different screen.
const ROUTE: Record<IssueLinkType, string> = {
  harness: 'harness',
  dataset: 'dataset',
  judge: 'judge',
  scorecard: 'scorecard',
  run: 'run',
  view: 'view',
}

// 이슈 상세가 "연결된 자산"으로 보여주고 걸 수 있는 종류 — 이슈를 **검증하는 능력** 셋뿐이다.
// 링크 모델 자체는 6종을 그대로 유지한다(제어 평면·MCP 는 계속 전부 받는다). 화면만 좁히는 이유:
//  - `scorecard` 는 능력이 아니라 증거다. 이슈에 고정된 스코어카드는 이미 "평가 이력" 섹션이 소유하고
//    (고정 배지 + 기준선 배지) 해결 기록이 기준선을 보여주므로, 여기에 또 칩으로 두면 같은 것이 한 화면에
//    두 번 나오고 둘 중 어느 쪽이 정본인지 흐려진다.
//  - `run`·`view` 는 이슈가 "무엇으로 검증되는가"에 답하지 않는다.
export const ISSUE_CAPABILITY_LINK_TYPES = [
  'harness',
  'dataset',
  'judge',
] as const satisfies readonly IssueLinkType[]

// EntityRef 는 버전이 있는 세 종류만 색으로 구분한다 — 나머지는 평범한 id@version 참조로 렌더된다.
export const ISSUE_LINK_REF_KIND: Partial<Record<IssueLinkType, 'dataset' | 'harness' | 'judge'>> =
  {
    dataset: 'dataset',
    harness: 'harness',
    judge: 'judge',
  }

export function issueLinkHref(workspace: string, type: IssueLinkType, id: string): string {
  return `/${workspace}/${ROUTE[type]}/${encodeURIComponent(id)}`
}
