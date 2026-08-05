import type { FacetOption } from './facet-filter-menu'

// 한 축이 실제로 제시할 값들 — **이 컬렉션에 있는 것만**. 워크스페이스의 모든 멤버로 담당자 축을 채우면
// 한 번도 무엇을 만든 적 없는 사람들의 이름이 메뉴를 덮고, 고르면 언제나 빈 목록이 나온다.
//
// 값이 하나도 없는 항목이 있으면 「없음」 버킷을 마지막에 붙인다(빈 문자열이 그 이름 — 쿼리 파라미터에는
// null 이 없다). 그런 항목이 하나도 없으면 붙이지 않는다: 아무것도 고르지 못하는 선택지는 선택지가 아니다.
export function facetOptionsOf<T>(
  items: readonly T[],
  valuesOf: (item: T) => readonly string[],
  labelOf: (value: string) => string,
  unsetLabel?: string
): FacetOption[] {
  const values = new Set<string>()
  let sawUnset = false
  for (const item of items) {
    const own = valuesOf(item)
    if (own.length === 0) sawUnset = true
    for (const value of own) values.add(value)
  }
  const options = [...values]
    .map((value) => ({ value, label: labelOf(value) }))
    .sort((a, b) => a.label.localeCompare(b.label))
  return sawUnset && unsetLabel !== undefined
    ? [...options, { value: '', label: unsetLabel }]
    : options
}
