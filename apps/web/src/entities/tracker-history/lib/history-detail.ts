// 이력 항목의 `detail` 은 이벤트마다 모양이 다른 자유 형태(`Record<string, unknown>`)다 — 상태 변경은
// from/to, 링크는 type/id, 완료는 forced/openIssues 를 싣는다. 읽는 쪽에서 좁히지 않으면 화면이 그대로
// 깨지므로, 모든 읽기는 이 네 개를 통과한다: 모양이 다르면 값이 없는 것으로 취급하고 그 칩만 사라진다.
export type HistoryDetail = Record<string, unknown> | undefined

export function detailString(detail: HistoryDetail, key: string): string | undefined {
  const value = detail?.[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

// 문자열 배열 필드(`changed`)만 남긴다 — 배열이 아니거나 원소가 문자열이 아니면 그 원소는 버린다.
export function detailStrings(detail: HistoryDetail, key: string): string[] {
  const value = detail?.[key]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0)
}

export function detailNumber(detail: HistoryDetail, key: string): number | undefined {
  const value = detail?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

// `true` 일 때만 참 — 문자열 "true" 나 1 은 플래그가 아니다(강행 완료처럼 경보를 띄우는 값이라 더 엄격하게).
export function detailFlag(detail: HistoryDetail, key: string): boolean {
  return detail?.[key] === true
}
