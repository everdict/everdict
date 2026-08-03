// 팀의 주소는 팀 키(`ENG`)다 — 이슈가 identifier(`ENG-12`)로 주소를 갖는 것과 같은 이유로, 붙여넣은 링크가
// 사람들이 그 팀을 부르는 이름 그대로 읽힌다. 제어 평면의 /teams/:ref 는 id 와 key 를 모두 받으므로 예전
// uuid 링크도 계속 열리고, 팀 화면이 열릴 때 이 형태로 정규화한다.
//
// 팀이 소유하는 것들은 쿼리 파라미터가 아니라 팀 아래의 경로 자원이다: `?team=<uuid>` 는 "무엇의 목록인가"를
// 필터로 감췄고, 무엇보다 팀마다 가진 자원이 다르다는 사실을 URL 이 말해 주지 못했다. 링크를 만드는 곳은
// 전부 이 함수들을 거쳐 슬러그 결정이 한 곳에만 존재하게 한다.

// 팀 아래에 사는 자원들. 사이드바의 팀 그룹이 여는 목적지이자, 팀 홈이 "전체 보기"로 잇는 곳이다.
export const TEAM_SECTIONS = ['issues', 'triage', 'cycles', 'projects', 'scorecards'] as const
export type TeamSection = (typeof TEAM_SECTIONS)[number]

// 팀 홈 — 이 팀이 지금 무엇을 하고 있나.
export function teamHref(workspace: string, key: string): string {
  return `/${workspace}/teams/${encodeURIComponent(key)}`
}

// 팀이 소유한 자원 목록 — `/{workspace}/teams/ENG/issues`.
export function teamSectionHref(workspace: string, key: string, section: TeamSection): string {
  return `${teamHref(workspace, key)}/${section}`
}

// 팀 설정(이름·키·로스터·보드) — 일하는 화면이 아니라 구성 화면이라 Settings 아래에 있지만, 주소는 같은 슬러그다.
export function teamSettingsHref(workspace: string, key: string): string {
  return `/${workspace}/settings/teams/${encodeURIComponent(key)}`
}
