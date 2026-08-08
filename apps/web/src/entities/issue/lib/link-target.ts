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
  // 한 이슈가 다른 이슈를 언급했을 때 — 링크가 들고 있는 건 UUID 이고, 상세 라우트가 그걸 정규 식별자
  // 주소로 넘겨 준다. 제목까지 아는 화면은 `issueHref` 로 슬러그 붙은 주소를 만든다.
  issue: 'issue',
  // The product timeline — a link points at one product or one release (singular detail routes).
  product: 'product',
  release: 'release',
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

// 속성 열이 골라 붙일 수 있는 종류. 링크 어휘의 부분집합이라 위 배열에서 파생한다 — 두 벌로 적어 두면
// 화면이 그리는 것과 고를 수 있는 것이 갈라진다.
export type IssueCapabilityLinkType = (typeof ISSUE_CAPABILITY_LINK_TYPES)[number]

// 능력이 아닌 **언급**. 능력 세 줄은 "이 이슈를 무엇으로 검증하는가"라는 고정된 질문이라 종류마다 자기 줄을
// 갖지만, 언급은 그런 질문이 아니라 자유로운 교차참조다 — 그래서 한 줄이 종류를 파라미터로 받는다.
// 지금은 `issue` 하나(사용자 결정: 이슈↔이슈부터). run·view 를 켜는 것은 이 배열에 한 줄 + 그 종류의
// 후보를 읽는 코드 한 곳이고, `scorecard` 는 여기 들어오지 않는다 — 스코어카드는 증거이고 "평가 이력"
// 섹션이 이미 소유한다(같은 것을 한 화면에 두 번 그리지 않는다).
export const ISSUE_MENTION_LINK_TYPES = ['issue'] as const satisfies readonly IssueLinkType[]
export type IssueMentionLinkType = (typeof ISSUE_MENTION_LINK_TYPES)[number]

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
