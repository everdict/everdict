import type { ListFilters } from '@/shared/lib/list-view'

// 평가 자원 목록의 `team` 필터 값은 팀 **id** 다(레지스트리가 그것으로 기록하니까). 그런데 이 목록들이
// 팀 아래의 경로 자원이던 시절에는 `?team=` 에 키(`ENG`)든 id 든 들어 있었고, 그 링크들이 지금도 돌아다닌다.
// 팀 키로 적힌 값을 id 로 바꿔 두면 그 링크가 조용히 "아무것도 없음"으로 열리는 일이 없다.
export function withResolvedTeamFilter(
  filters: ListFilters,
  teams: readonly { id: string; key: string }[]
): ListFilters {
  const values = filters.team
  if (values === undefined || values.length === 0) return filters
  const byKey = new Map(teams.map((team) => [team.key.toLocaleLowerCase(), team.id]))
  const ids = new Set(teams.map((team) => team.id))
  const resolved = values.map((value) =>
    // 이미 id 면 그대로. 모르는 값도 그대로 둔다 — 사라진 팀을 가리키는 필터를 조용히 넓히면 "우리 팀 것만"이
    // 갑자기 전부가 된다.
    ids.has(value) ? value : (byKey.get(value.toLocaleLowerCase()) ?? value)
  )
  return { ...filters, team: resolved }
}
