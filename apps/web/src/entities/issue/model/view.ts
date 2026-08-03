import type {
  IssueGroupBy as WireIssueGroupBy,
  IssueGroupCount as WireIssueGroupCount,
  IssueGroupCounts as WireIssueGroupCounts,
  IssueOrder as WireIssueOrder,
} from '@everdict/contracts'
import { z } from 'zod'

import { ISSUE_PRIORITIES, ISSUE_STATUSES, type IssuePriority, type IssueStatus } from './schema'

// 이슈 목록을 "어떻게 볼 것인가" — 묶는 기준·정렬·레이아웃·필터. 목록의 상태이지 이슈의 상태가 아니므로
// 레코드가 아니라 URL 이 들고 있고(붙여넣은 링크가 같은 화면을 연다), 여기 있는 것은 그 URL 과 화면 사이의
// 순수 산술뿐이다: 파싱·직렬화·그룹 나누기. 컴포넌트가 이 규칙을 각자 발명하면 필터 칩과 그룹 헤더가
// 서로 다른 목록을 말하기 시작한다.

// 묶는 기준. 전부 이슈의 스칼라 필드라 한 이슈는 정확히 한 그룹에 속한다 — 라벨이 빠진 이유는 제어 평면과
// 같다(이슈 하나가 여러 라벨을 들고 있어서 그룹 합이 목록보다 커진다).
export const ISSUE_GROUP_BYS = ['status', 'assignee', 'priority', 'project', 'cycle'] as const
export const issueGroupBySchema = z.enum(ISSUE_GROUP_BYS)
export type IssueGroupBy = WireIssueGroupBy

// 묶지 않고 한 줄로 — 그룹 기준의 한 값이 아니라 별도 값이다. 제어 평면의 `groupBy` 는 집계를 위한 것이라
// "안 묶음"이라는 답이 없다(집계할 것이 없으니까).
export const ISSUE_GROUPINGS = ['none', ...ISSUE_GROUP_BYS] as const
export const issueGroupingSchema = z.enum(ISSUE_GROUPINGS)
export type IssueGrouping = (typeof ISSUE_GROUPINGS)[number]

export const ISSUE_ORDERS = ['updated', 'created', 'priority', 'due'] as const
export const issueOrderSchema = z.enum(ISSUE_ORDERS)
export type IssueOrder = WireIssueOrder

// 목록이냐 보드냐. 보드는 그룹을 컬럼으로 세우므로 「묶지 않음」과는 함께 설 수 없다 — `issueViewOf` 가
// 그 조합을 상태 그룹으로 되돌린다(빈 화면 대신 뜻이 통하는 화면).
export const ISSUE_LAYOUTS = ['list', 'board'] as const
export const issueLayoutSchema = z.enum(ISSUE_LAYOUTS)
export type IssueLayout = (typeof ISSUE_LAYOUTS)[number]

export const issueGroupCountSchema = z.object({
  key: z.string().nullable(),
  count: z.number(),
})

export const issueGroupCountsSchema = z.object({
  groupBy: issueGroupBySchema,
  groups: z.array(issueGroupCountSchema),
  total: z.number(),
})

export type IssueGroupCount = WireIssueGroupCount
export type IssueGroupCounts = WireIssueGroupCounts

// 화면 하나를 완전히 결정하는 값. URL 로 왕복하므로 두 사람이 같은 링크에서 같은 화면을 본다.
export interface IssueView {
  grouping: IssueGrouping
  order: IssueOrder
  layout: IssueLayout
  // 완료·취소된 이슈를 함께 볼지. 기본이 「감춤」인 이유는 리니어와 같다 — 목록은 "지금 할 일"이고,
  // 끝난 일은 대개 그 화면의 답이 아니다. 상태를 명시적으로 고르면 그 선택이 이긴다.
  showCompleted: boolean
  // 하위 이슈를 각자의 줄로 낼지, 최상위만 낼지. 후자가 보드의 기본형이다(자식이 부모와 따로 서면 같은
  // 일이 두 번 세어진 것처럼 읽힌다).
  subIssues: 'all' | 'top'
  filters: IssueFilters
}

// 필터는 축마다 "이 중 아무거나". 빈 배열이 아니라 아예 없는 것이 「그 축은 안 걸었다」다 — 배열이 비었다는
// 건 "고르긴 했는데 아무것도" 라서 제어 평면이 아무것도 안 주는 게 맞다.
export interface IssueFilters {
  status?: IssueStatus[]
  priority?: IssuePriority[]
  // 빈 문자열은 「담당자 없음」 — 쿼리 파라미터에는 null 이 없고, 그 버킷은 실제로 사람들이 거르는 그룹이다.
  assignee?: string[]
  label?: string[]
  project?: string[]
  cycle?: string[]
}

export const ISSUE_FILTER_FACETS = [
  'status',
  'priority',
  'assignee',
  'label',
  'project',
  'cycle',
] as const
export type IssueFilterFacet = (typeof ISSUE_FILTER_FACETS)[number]

export const DEFAULT_ISSUE_VIEW: IssueView = {
  grouping: 'status',
  order: 'updated',
  layout: 'list',
  showCompleted: false,
  subIssues: 'all',
  filters: {},
}

// 완료/취소 — 「완료 이슈 표시」가 끄는 대상. 회귀는 여기 없다: 판정이 무너진 이슈는 끝난 일이 아니다.
const COMPLETED_STATUSES: IssueStatus[] = ['done', 'cancelled']

// URL 이 들고 다니는 이름들. 짧게 쓰지 않는 이유는 붙여넣은 주소를 사람이 읽기 때문이다.
export type IssueViewParams = {
  group?: string
  order?: string
  layout?: string
  completed?: string
  sub?: string
  status?: string | string[]
  priority?: string | string[]
  assignee?: string | string[]
  label?: string | string[]
  project?: string | string[]
  cycle?: string | string[]
  cursor?: string
}

// 하나든 여럿이든 배열로. `?status=todo&status=done` 이 집합의 철자다.
function asArray(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined
  return Array.isArray(value) ? value : [value]
}

// 닫힌 어휘만 통과시킨다 — 주소창에 아무 값이나 칠 수 있으므로, 모르는 값은 무시하고 기본값으로 떨어진다
// (목록이 400 으로 죽는 것보다 낫다).
function pickEnum<T extends string>(value: string | undefined, allowed: readonly T[]): T | undefined {
  return allowed.find((option) => option === value)
}

function pickAll<T extends string>(
  value: string | string[] | undefined,
  allowed: readonly T[]
): T[] | undefined {
  const raw = asArray(value)
  if (raw === undefined) return undefined
  return raw.filter((item): item is T => allowed.some((option) => option === item))
}

// URL → 화면. 알 수 없는 값은 조용히 기본값이 되고, 뜻이 통하지 않는 조합(보드인데 안 묶음)은 통하는 쪽으로
// 정규화된다 — 사용자가 만들 수 있는 주소 중에 "아무것도 안 나오는 화면"이 없도록.
export function issueViewOf(params: IssueViewParams): IssueView {
  const grouping = pickEnum(params.group, ISSUE_GROUPINGS) ?? DEFAULT_ISSUE_VIEW.grouping
  const layout = pickEnum(params.layout, ISSUE_LAYOUTS) ?? DEFAULT_ISSUE_VIEW.layout
  const filters: IssueFilters = {
    ...(pickAll(params.status, ISSUE_STATUSES) !== undefined
      ? { status: pickAll(params.status, ISSUE_STATUSES) }
      : {}),
    ...(pickAll(params.priority, ISSUE_PRIORITIES) !== undefined
      ? { priority: pickAll(params.priority, ISSUE_PRIORITIES) }
      : {}),
    ...(asArray(params.assignee) !== undefined ? { assignee: asArray(params.assignee) } : {}),
    ...(asArray(params.label) !== undefined ? { label: asArray(params.label) } : {}),
    ...(asArray(params.project) !== undefined ? { project: asArray(params.project) } : {}),
    ...(asArray(params.cycle) !== undefined ? { cycle: asArray(params.cycle) } : {}),
  }
  return {
    // 보드는 컬럼이 곧 그룹이다 — 묶지 않은 보드는 그릴 것이 없으므로 상태 컬럼으로 되돌린다.
    grouping: layout === 'board' && grouping === 'none' ? 'status' : grouping,
    order: pickEnum(params.order, ISSUE_ORDERS) ?? DEFAULT_ISSUE_VIEW.order,
    layout,
    showCompleted: params.completed === '1',
    subIssues: params.sub === 'top' ? 'top' : 'all',
    filters,
  }
}

// 화면 → URL. 기본값은 쓰지 않는다: 주소가 짧아야 사람이 읽고, 기본값이 박힌 주소는 나중에 기본값을 바꿔도
// 옛 화면에 고정된다.
export function issueViewQuery(view: IssueView): URLSearchParams {
  const q = new URLSearchParams()
  if (view.grouping !== DEFAULT_ISSUE_VIEW.grouping) q.set('group', view.grouping)
  if (view.order !== DEFAULT_ISSUE_VIEW.order) q.set('order', view.order)
  if (view.layout !== DEFAULT_ISSUE_VIEW.layout) q.set('layout', view.layout)
  if (view.showCompleted) q.set('completed', '1')
  if (view.subIssues === 'top') q.set('sub', 'top')
  for (const facet of ISSUE_FILTER_FACETS) {
    for (const value of view.filters[facet] ?? []) q.append(facet, value)
  }
  return q
}

// 이 화면의 주소. 커서는 절대 물려주지 않는다 — 다른 목록의 위치이므로, 보기가 바뀌면 언제나 1장부터다.
export function issueViewHref(basePath: string, view: IssueView): string {
  const qs = issueViewQuery(view).toString()
  return `${basePath}${qs ? `?${qs}` : ''}`
}

// 한 축의 값을 켜고 끈다 — 필터 메뉴의 유일한 동작. 마지막 값을 끄면 그 축 자체가 사라진다(빈 배열로 남으면
// "아무것도 안 고른 축"이 되어 목록이 통째로 빈다).
export function toggleIssueFilter(
  filters: IssueFilters,
  facet: IssueFilterFacet,
  value: string
): IssueFilters {
  const current = filters[facet] ?? []
  const next = current.includes(value)
    ? current.filter((item) => item !== value)
    : [...current, value]
  const { [facet]: _dropped, ...rest } = filters
  return next.length === 0 ? rest : { ...rest, [facet]: next }
}

export function issueFilterCount(filters: IssueFilters): number {
  return ISSUE_FILTER_FACETS.reduce((sum, facet) => sum + (filters[facet]?.length ?? 0), 0)
}

// 화면 → 제어 평면 질의. 「완료 감춤」이 상태 필터로 번역되는 곳이 여기다: 서버가 이해하는 어휘는 상태
// 집합뿐이고, 사용자가 상태를 직접 골랐다면 그 선택이 이긴다(명시적 선택을 UI 기본값이 덮으면 고장이다).
export function issueQueryFilters(view: IssueView): IssueFilters & { parent?: string } {
  const status =
    view.filters.status ??
    (view.showCompleted ? undefined : ISSUE_STATUSES.filter((s) => !COMPLETED_STATUSES.includes(s)))
  return {
    ...view.filters,
    ...(status !== undefined ? { status } : {}),
    ...(view.subIssues === 'top' ? { parent: 'none' } : {}),
  }
}

// 그룹을 그릴 순서. 상태와 우선순위는 어휘 자체가 순서다(진행 중이 백로그 위에 있어야 보드로 읽힌다);
// 사람·프로젝트·사이클은 이름의 순서가 없으므로 제어 평면이 준 「큰 그룹 먼저」를 그대로 따른다.
const STATUS_BOARD_ORDER: IssueStatus[] = [
  'regressed',
  'in_progress',
  'in_review',
  'todo',
  'backlog',
  'done',
  'cancelled',
]

export function orderIssueGroups(
  groups: readonly IssueGroupCount[],
  groupBy: IssueGroupBy
): IssueGroupCount[] {
  const vocabulary: readonly string[] | undefined =
    groupBy === 'status' ? STATUS_BOARD_ORDER : groupBy === 'priority' ? ISSUE_PRIORITIES : undefined
  if (vocabulary === undefined) return [...groups]
  return [...groups].sort((a, b) => {
    if (a.key === null) return b.key === null ? 0 : 1
    if (b.key === null) return -1
    return vocabulary.indexOf(a.key) - vocabulary.indexOf(b.key)
  })
}

// 보드/그룹 목록이 실제로 세우는 그룹들. 제어 평면은 이슈가 있는 그룹만 세지만, 상태·우선순위는 **비어
// 있어도 컬럼이 서야** 한다 — 아무도 안 하고 있는 「진행 중」이 사라지면 보드는 그 칸이 없는 것처럼 읽히고,
// 무엇보다 그리로 카드를 끌어다 놓을 자리가 없어진다.
export function issueGroupsToRender(
  counts: readonly IssueGroupCount[],
  groupBy: IssueGroupBy,
  view: IssueView
): IssueGroupCount[] {
  const seen = new Map(counts.map((group) => [group.key, group.count]))
  if (groupBy === 'status') {
    const columns = STATUS_BOARD_ORDER.filter(
      // 「완료 이슈 표시」를 끈 화면에 완료 컬럼을 세우면 언제나 0 이다 — 끈 것을 다시 보여주는 셈이다.
      (status) =>
        view.filters.status?.includes(status) ??
        (view.showCompleted || !COMPLETED_STATUSES.includes(status))
    )
    return columns.map((status) => ({ key: status, count: seen.get(status) ?? 0 }))
  }
  if (groupBy === 'priority') {
    return ISSUE_PRIORITIES.filter(
      (priority) => view.filters.priority?.includes(priority) ?? true
    ).map((priority) => ({ key: priority, count: seen.get(priority) ?? 0 }))
  }
  // 나머지 축은 어휘가 열려 있다 — 워크스페이스의 모든 멤버로 컬럼을 세우면 한 번도 이슈를 받은 적 없는
  // 사람들의 빈 칸이 화면을 채운다. 제어 평면이 센 그룹만, 센 순서(큰 것 먼저)대로.
  return [...counts]
}

// 드리프트 가드 — 로컬 어휘와 와이어 계약이 상호 대입 가능해야 한다.
type AssertAssignable<A extends B, B> = A
type _groupByFwd = AssertAssignable<z.infer<typeof issueGroupBySchema>, WireIssueGroupBy>
type _groupByBack = AssertAssignable<WireIssueGroupBy, z.infer<typeof issueGroupBySchema>>
type _orderFwd = AssertAssignable<z.infer<typeof issueOrderSchema>, WireIssueOrder>
type _orderBack = AssertAssignable<WireIssueOrder, z.infer<typeof issueOrderSchema>>
type _countsFwd = AssertAssignable<z.infer<typeof issueGroupCountsSchema>, WireIssueGroupCounts>
type _countsBack = AssertAssignable<WireIssueGroupCounts, z.infer<typeof issueGroupCountsSchema>>

export type __issueViewDriftGuard = [
  _groupByFwd,
  _groupByBack,
  _orderFwd,
  _orderBack,
  _countsFwd,
  _countsBack,
]
