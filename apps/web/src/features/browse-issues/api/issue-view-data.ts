import 'server-only'

import {
  issueGroupCountsSchema,
  issueGroupsToRender,
  issuePageSchema,
  issueQueryFilters,
  orderIssueGroups,
  type IssueGroupBy,
  type IssueGroupCount,
  type IssuePage,
  type IssueSummary,
  type IssueView,
} from '@/entities/issue'
import { controlPlane, type AuthContext } from '@/shared/lib/control-plane'

import type { IssuePageQuery } from '../model/page-query'

// 이슈 목록 화면 하나의 **데이터**. 서버 컴포넌트(첫 화면)와 서버 액션(보기를 바꿨을 때)이 같은 함수를
// 부르는 것이 요점이다: 두 벌이면 필터를 바꾼 뒤의 목록과 새로고침한 뒤의 목록이 달라질 수 있다.
//
// 보기가 바뀔 때 라우트 전체를 다시 그리지 않는 이유는 계산해 보면 분명하다. 예전에는 필터 하나를 켜면
// `router.push` 가 페이지를 다시 렌더했고, 그 렌더는 목록과 아무 상관 없는 것들(멤버·프로젝트·사이클·라벨·
// 팀 로스터, GitHub App 상태)까지 전부 다시 읽은 뒤에야 화면을 그렸다 — 그동안 화면은 스켈레톤이었다.
// 지금은 이 함수가 돌려주는 것만 새로 받고, 그동안 이전 목록이 화면에 그대로 서 있는다.

// 그룹 하나가 처음 그리는 행 수. 묶인 화면은 그룹마다 자기 장을 갖고, 「더 보기」가 그 그룹에만 이어 붙인다.
const GROUP_PAGE = 25
// 묶지 않은 목록의 한 장.
const FLAT_PAGE = 50
// 보드 컬럼 하나가 그리는 카드 수 — 훑는 화면이라 컬럼 안 페이지네이션 대신, 못 그린 수를 컬럼이 말한다.
const BOARD_PAGE = 20
// 한 화면에 세우는 그룹 수의 상한. 담당자로 묶은 200명짜리 워크스페이스가 200번의 조회가 되지 않도록 막되,
// 잘랐다는 사실은 화면에 남긴다(조용한 상한은 "전부 봤다"로 읽힌다).
const MAX_GROUPS = 20

// 이 목록이 무엇의 목록인가 — 필터가 아니라 **주소**가 정하는 좁히기. 팀·트리아지·사이클은 화면이 서 있는
// 자리이므로 보기를 바꿔도 변하지 않는다.
export interface IssueViewBase {
  team?: string
  triage?: boolean
  cycle?: string
}

export interface IssueViewRequest {
  base: IssueViewBase
  view: IssueView
}

export interface IssueViewGroup {
  key: string | null
  // 서버 집계가 센 수. 받은 행을 세면 페이지 크기를 되풀이할 뿐이다.
  count: number
  items: IssueSummary[]
  nextCursor?: string
  // 이 그룹의 다음 장을 가져올 질의 — 「더 보기」가 그대로 쓴다.
  query: IssuePageQuery
}

export interface IssueViewData {
  groupBy?: IssueGroupBy
  total?: number
  groups: IssueViewGroup[]
  flat?: { items: IssueSummary[]; nextCursor?: string }
  flatQuery?: IssuePageQuery
  // 세우지 않은 그룹 수 — 0 이 아니면 화면이 그 사실을 말한다.
  droppedGroups: number
  // 목록 자체를 못 읽었을 때. 집계 실패가 자기 종류를 갖는 이유는 화면이 다른 말을 해야 하기 때문이다:
  // 묶인 화면은 집계 없이는 그릴 근거가 없고, 「이슈 없음」으로 떨어지면 있는 이슈를 없다고 말하게 된다.
  error?: { kind: 'counts' } | { kind: 'load'; message: string }
}

// 이 목록의 좁히기. 행과 그룹 개수가 **같은** 필터를 쓰도록 한 번만 만든다.
// 사이클 스코프는 URL 의 사이클 필터를 덮어쓴다 — 이 화면은 "그 이터레이션의 보드"이지 "사이클로 좁힌
// 이슈 목록"이 아니라서, 주소가 이미 답한 것을 필터가 다시 뒤집을 수 있으면 안 된다.
export function issueScopeOf({ base, view }: IssueViewRequest): IssuePageQuery {
  return {
    ...issueQueryFilters(view),
    ...(base.team !== undefined ? { team: base.team } : {}),
    ...(base.triage === true ? { triage: true } : {}),
    ...(base.cycle !== undefined ? { cycle: [base.cycle] } : {}),
  }
}

// 한 그룹만 고르는 질의 — 목록 전체의 좁히기에 그 그룹의 값을 하나 더 얹는다. 미지정 버킷은 빈 문자열이다
// (쿼리 파라미터에 null 이 없다). 이미 그 축에 필터가 걸려 있어도 여기서 덮어쓴다: 이 요청은 "이 그룹"이지
// "이 그룹 ∩ 사용자가 고른 값들"이 아니고, 그룹 목록 자체가 이미 그 필터를 통과해 나온 것이다.
function groupQuery(
  scope: IssuePageQuery,
  groupBy: IssueGroupBy,
  group: IssueGroupCount,
  order: string,
  limit: number
): IssuePageQuery {
  const value = group.key ?? ''
  const facet =
    groupBy === 'status'
      ? { status: [value] }
      : groupBy === 'priority'
        ? { priority: [value] }
        : groupBy === 'assignee'
          ? { assignee: [value] }
          : groupBy === 'project'
            ? { project: [value] }
            : { cycle: [value] }
  return { ...scope, ...facet, order, limit }
}

export async function loadIssueViewData(
  ctx: AuthContext,
  request: IssueViewRequest
): Promise<IssueViewData> {
  const { view } = request
  const scope = issueScopeOf(request)

  if (view.grouping === 'none') {
    const query: IssuePageQuery = { ...scope, order: view.order, limit: FLAT_PAGE }
    try {
      const page = issuePageSchema.parse(await controlPlane.listIssues(ctx, query))
      return {
        groups: [],
        flat: {
          items: page.items,
          ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
        },
        flatQuery: query,
        droppedGroups: 0,
      }
    } catch (e) {
      return {
        groups: [],
        droppedGroups: 0,
        error: { kind: 'load', message: e instanceof Error ? e.message : String(e) },
      }
    }
  }

  const counts = await controlPlane
    .countIssues(ctx, view.grouping, scope)
    .then((r) => issueGroupCountsSchema.parse(r))
    .catch(() => undefined)
  if (counts === undefined) return { groups: [], droppedGroups: 0, error: { kind: 'counts' } }

  const rendered = orderIssueGroups(
    issueGroupsToRender(counts.groups, counts.groupBy, view),
    counts.groupBy
  )
  const shown = rendered.slice(0, MAX_GROUPS)
  const perGroupLimit = view.layout === 'board' ? BOARD_PAGE : GROUP_PAGE

  const pages = await Promise.all(
    shown.map((group) =>
      // 빈 그룹은 조회하지 않는다 — 보드가 세워 둔 빈 컬럼(끌어다 놓을 자리)이 왕복을 만들면 안 된다.
      group.count === 0
        ? Promise.resolve<IssuePage | undefined>({ items: [] })
        : controlPlane
            .listIssues(ctx, groupQuery(scope, counts.groupBy, group, view.order, perGroupLimit))
            .then((r) => issuePageSchema.parse(r))
            .catch((): IssuePage | undefined => undefined)
    )
  )

  return {
    groupBy: counts.groupBy,
    total: counts.total,
    groups: shown.map((group, index) => {
      const page = pages[index]
      return {
        key: group.key,
        count: group.count,
        items: page?.items ?? [],
        ...(page?.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
        query: groupQuery(scope, counts.groupBy, group, view.order, perGroupLimit),
      }
    }),
    droppedGroups: rendered.length - shown.length,
  }
}
