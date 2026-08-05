import {
  decodeKeyedPreference,
  readPreferenceCookie,
  withKeyedPreference,
  writePreferenceCookie,
} from './keyed-preference'

// 목록 화면 하나가 "무엇을 보여 주는가"를 정하는 두 반쪽. 이슈 목록이 세운 문법을 그대로 일반화한 것이라
// 규칙도 같다(`entities/issue/model/view.ts` 가 그 원본이고 이 모듈의 어휘를 공유한다).
//
//   · **어느 것들** — 필터. 집합을 정하므로 URL 에 산다: 붙여넣은 링크는 받는 사람에게도 같은 집합을 열어야 한다.
//   · **어떻게 그리나** — 묶기·정렬. 집합은 그대로 두고 눈만 바꾸므로 읽는 사람의 쿠키에 산다: 링크가 받는
//     사람의 화면 배치를 바꿔서는 안 된다.
//
// 평가 자원 목록들(하네스·데이터셋·저지·스코어카드)은 컬렉션 전체를 한 번에 받아 오므로 이 계산이 전부
// 브라우저에서 일어난다 — 그래서 필터를 켜고 묶는 기준을 바꾸는 데 왕복이 0회다.

export type ListFilters = Record<string, readonly string[]>

// 어떻게 그리나. 레이아웃(보드)이 없는 이유는 이 목록들이 컬럼으로 설 만한 닫힌 상태 축을 갖지 않아서다 —
// 필요해지면 이슈 목록처럼 여기에 한 필드가 붙는다.
export interface ListDisplay {
  grouping: string
  order: string
}

// 한 축의 값을 켜고 끈다 — 필터 메뉴의 유일한 동작. 마지막 값을 끄면 그 축 자체가 사라진다: 빈 배열로 남으면
// "고르긴 했는데 아무것도"가 되어 목록이 통째로 빈다.
export function toggleListFilter(filters: ListFilters, facet: string, value: string): ListFilters {
  const current = filters[facet] ?? []
  const next = current.includes(value)
    ? current.filter((item) => item !== value)
    : [...current, value]
  const { [facet]: _dropped, ...rest } = filters
  return next.length === 0 ? rest : { ...rest, [facet]: next }
}

export function listFilterCount(filters: ListFilters): number {
  return Object.values(filters).reduce((sum, values) => sum + values.length, 0)
}

function asArray(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined
  return Array.isArray(value) ? value : [value]
}

// URL → 필터. 아는 축만 읽는다 — 주소창에는 무엇이든 칠 수 있으니, 모르는 이름은 400 을 만드는 대신 버린다.
export function listFiltersOf(
  params: Record<string, string | string[] | undefined> | URLSearchParams,
  facets: readonly string[]
): ListFilters {
  const read = (facet: string): string[] | undefined =>
    params instanceof URLSearchParams
      ? params.getAll(facet).length > 0
        ? params.getAll(facet)
        : undefined
      : asArray(params[facet])
  const filters: Record<string, string[]> = {}
  for (const facet of facets) {
    const values = read(facet)
    if (values !== undefined && values.length > 0) filters[facet] = values
  }
  return filters
}

// 필터 + 검색어 → 이 화면의 쿼리. 표시 설정은 절대 여기 오지 않는다(그게 쿠키로 간 이유다).
export function listViewQuery(
  filters: ListFilters,
  facets: readonly string[],
  search?: string
): URLSearchParams {
  const q = new URLSearchParams()
  for (const facet of facets) {
    for (const value of filters[facet] ?? []) q.append(facet, value)
  }
  if (search !== undefined && search !== '') q.set('q', search)
  return q
}

// --- 적용 ---

export interface ListGroup<T> {
  key: string | null
  items: T[]
}

// 한 자원 목록이 자기 어휘를 이 네 함수로 말한다 — 나머지(켜고 끄기·묶기·세기)는 전부 공용이다.
export interface ListViewSpec<T> {
  // 이 항목이 그 축에서 갖는 값들. 여럿일 수 있고(태그), 하나도 없을 수 있다(미지정 — 빈 문자열로 표현).
  facetValues: (item: T, facet: string) => readonly string[]
  // 검색이 훑는 텍스트.
  searchText: (item: T) => string
  // 이 항목이 속하는 그룹. null 은 「미지정」 버킷이다.
  groupKey: (item: T, grouping: string) => string | null
  compare: (a: T, b: T, order: string) => number
  // 그룹을 세우는 순서. 닫힌 어휘면 그 어휘 자체가 순서고(상태), 날짜처럼 값에 순서가 있으면 비교 함수다.
  // 아무것도 돌려주지 않으면 큰 그룹 먼저 — 이름에 순서가 없는 축(사람·팀)의 유일하게 말이 되는 정렬이다.
  groupOrder?: (
    grouping: string
  ) => readonly string[] | ((a: string, b: string) => number) | undefined
}

export interface ListViewInput {
  filters: ListFilters
  search: string
  display: ListDisplay
}

// 한 화면이 실제로 그리는 것. 개수는 여기서 세므로 헤더의 숫자와 그 아래 행이 어긋날 수 없다 —
// 서버가 그룹마다 한 장씩 가져오는 이슈 목록과 달리, 여기서는 컬렉션 전체가 손에 있다.
export function applyListView<T>(
  items: readonly T[],
  view: ListViewInput,
  spec: ListViewSpec<T>
): { total: number; groups: ListGroup<T>[] } {
  const needle = view.search.trim().toLocaleLowerCase()
  const matched = items.filter((item) => {
    if (needle !== '' && !spec.searchText(item).toLocaleLowerCase().includes(needle)) return false
    return Object.entries(view.filters).every(([facet, selected]) => {
      if (selected.length === 0) return true
      const values = spec.facetValues(item, facet)
      // 값이 하나도 없는 항목은 「미지정」(빈 문자열)으로 거를 수 있어야 한다 — 사람들이 실제로 거르는 버킷이다.
      const effective = values.length === 0 ? [''] : values
      return effective.some((value) => selected.includes(value))
    })
  })
  const sorted = [...matched].sort((a, b) => spec.compare(a, b, view.display.order))
  if (view.display.grouping === 'none') {
    return { total: sorted.length, groups: [{ key: null, items: sorted }] }
  }

  const buckets = new Map<string | null, T[]>()
  for (const item of sorted) {
    const key = spec.groupKey(item, view.display.grouping)
    const bucket = buckets.get(key)
    if (bucket === undefined) buckets.set(key, [item])
    else bucket.push(item)
  }
  const vocabulary = spec.groupOrder?.(view.display.grouping)
  const groups = [...buckets].map(([key, groupItems]) => ({ key, items: groupItems }))
  groups.sort((a, b) => {
    // 미지정 버킷은 언제나 끝 — 이름이 없는 그룹이 이름 있는 것들 사이에 섞이면 목록이 아니라 잔해로 읽힌다.
    if (a.key === null || b.key === null) return a.key === null ? (b.key === null ? 0 : 1) : -1
    if (typeof vocabulary === 'function') return vocabulary(a.key, b.key)
    if (vocabulary !== undefined) return vocabulary.indexOf(a.key) - vocabulary.indexOf(b.key)
    if (a.items.length !== b.items.length) return b.items.length - a.items.length
    return a.key.localeCompare(b.key)
  })
  return { total: sorted.length, groups }
}

// --- 표시 설정의 저장 ---

export const LIST_DISPLAY_COOKIE = 'everdict-list-display'

// 쿠키가 기억하는 화면 수. 모든 요청에 실려 가므로 상한이 있어야 한다(이슈 목록의 그것과 같은 이유·같은 수).
const MAX_REMEMBERED_VIEWS = 12

// 한 화면의 표시 설정 두 필드를 `묶기-정렬` 로 적는다. 자리로 구분하는 이유는 어느 어휘에도 `-` 가 없고,
// 쿠키는 URL 과 달리 사람이 읽는 것이 아니기 때문이다.
function encodeOne(display: ListDisplay): string {
  return `${display.grouping}-${display.order}`
}

function pick(value: string | undefined, allowed: readonly string[], fallback: string): string {
  return allowed.find((option) => option === value) ?? fallback
}

export interface ListDisplayVocabulary {
  groupings: readonly string[]
  orders: readonly string[]
  fallback: ListDisplay
}

// 저장된 설정은 믿지 않는다 — 쿠키이고, 그 아래에서 어휘가 바뀔 수 있다(묶기 기준의 이름이 바뀌거나 사라진다).
// 필드마다 따로 기본값으로 떨어지므로, 낡은 단어 하나는 그 단어만큼만 잃는다.
export function listDisplayFor(
  cookie: string | undefined,
  viewKey: string,
  vocabulary: ListDisplayVocabulary
): ListDisplay {
  const raw = decodeKeyedPreference(cookie).get(viewKey)
  if (raw === undefined) return vocabulary.fallback
  const [grouping, order] = raw.split('-')
  return {
    grouping: pick(grouping, vocabulary.groupings, vocabulary.fallback.grouping),
    order: pick(order, vocabulary.orders, vocabulary.fallback.order),
  }
}

export function withListDisplay(
  cookie: string | undefined,
  viewKey: string,
  display: ListDisplay
): string {
  return withKeyedPreference(cookie, viewKey, encodeOne(display), MAX_REMEMBERED_VIEWS)
}

// 브라우저에서 바로 써 넣는다 — 서버 액션 왕복 없이. 다음에 이 화면을 열 때 서버가 읽을 값이고,
// 지금 화면은 이미 클라이언트 상태로 바뀌어 있다.
export function saveListDisplay(viewKey: string, display: ListDisplay): void {
  writePreferenceCookie(
    LIST_DISPLAY_COOKIE,
    withListDisplay(readPreferenceCookie(LIST_DISPLAY_COOKIE), viewKey, display)
  )
}
