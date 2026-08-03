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

// A team's "create one of these" screen — `/{workspace}/teams/ENG/scorecards/new`. Creating under the team's own
// address is what carries the owner: the same form at the workspace address has to infer whose it is, and the
// inference is exactly what put every batch in one team.
export function teamNewHref(workspace: string, key: string, section: TeamSection): string {
  return `${teamSectionHref(workspace, key, section)}/new`
}

// 팀 설정(이름·키·로스터·보드) — 일하는 화면이 아니라 구성 화면이라 Settings 아래에 있지만, 주소는 같은 슬러그다.
export function teamSettingsHref(workspace: string, key: string): string {
  return `/${workspace}/settings/teams/${encodeURIComponent(key)}`
}

// 경로가 가리키는 팀 스코프. `section` 은 팀 홈이면 'home', 팀 아래이긴 하지만 우리가 이름을 붙인 자원이
// 아니면 null 이다 — 그래도 그 팀의 화면이라는 사실은 변하지 않는다.
export interface TeamPathScope {
  key: string
  section: TeamSection | 'home' | null
}

// href 빌더의 역방향 — 주소를 다시 팀 스코프로 읽는다. 이것이 "이 경로는 누구의 것인가"에 답하는 **유일한**
// 판정이어야 한다: 사이드바의 워크스페이스 나브와 팀 그룹이 각자 답하던 시절에는 `/teams` 행이 접두사만 보고
// 모든 팀 화면을 자기 것이라 주장해, 팀 하위 페이지마다 두 행이 동시에 활성화됐다.
// 정규식이 아니라 문자열로 자른다 — 워크스페이스 슬러그를 정규식에 끼워 넣으면 슬러그 안의 메타문자가 패턴이
// 되어 버린다.
export function matchTeamPath(pathname: string, workspace: string): TeamPathScope | null {
  const prefix = `/${workspace}/teams/`
  if (!pathname.startsWith(prefix)) return null
  const segments = pathname.slice(prefix.length).split('/')
  // `/{workspace}/teams` 와 `/{workspace}/teams/` 는 팀 디렉터리이지 어느 팀의 화면도 아니다.
  const key = decodeSegment(segments[0])
  if (key === '') return null
  const rawSection = segments.length > 1 ? segments[1] : ''
  if (rawSection === '') return { key, section: 'home' }
  // 자원 아래로 더 깊이 들어간 주소(상세 화면)도 여전히 그 자원의 것이다.
  return { key, section: TEAM_SECTIONS.find((section) => section === rawSection) ?? null }
}

// 손으로 친 주소에 깨진 이스케이프가 들어와도 렌더가 죽지 않게 — 디코딩할 수 없는 세그먼트는 그 어떤 팀 키도
// 아니므로, 원문 그대로 두면 아무 팀과도 매치되지 않는다.
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}
