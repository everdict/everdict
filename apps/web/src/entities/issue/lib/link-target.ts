import type { IssueLinkType } from '../model/schema'

// 링크가 가리키는 곳. 링크는 검증하지 않는 포인터라 대상이 404 일 수 있다 — 그게 "존재하기 전(또는 후)의
// 자산도 참조할 수 있다"의 대가다. 링크를 그리는 화면(속성 패널·이력)이 같은 주소를 쓰도록 한 곳에 둔다.
const ROUTE: Record<IssueLinkType, string> = {
  harness: 'harnesses',
  dataset: 'datasets',
  judge: 'judges',
  scorecard: 'scorecards',
  run: 'runs',
  view: 'views',
}

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
