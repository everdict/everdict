import { pluralSegment } from '@/shared/lib/resource-routes'

// 팀의 주소는 팀 키(`ENG`)다 — 이슈가 identifier(`ENG-12`)로 주소를 갖는 것과 같은 이유로, 붙여넣은 링크가
// 사람들이 그 팀을 부르는 이름 그대로 읽힌다. 제어 평면의 /teams/:ref 는 id 와 key 를 모두 받으므로 예전
// uuid 링크도 계속 열리고, 팀 화면이 열릴 때 이 형태로 정규화한다.
//
// 팀이 소유하는 것들은 쿼리 파라미터가 아니라 팀 아래의 경로 자원이다: `?team=<uuid>` 는 "무엇의 목록인가"를
// 필터로 감췄고, 무엇보다 팀마다 가진 자원이 다르다는 사실을 URL 이 말해 주지 못했다. 링크를 만드는 곳은
// 전부 이 함수들을 거쳐 슬러그 결정이 한 곳에만 존재하게 한다.

// 팀 아래에 사는 자원들. 사이드바의 팀 그룹이 여는 목적지이자, 팀 홈이 "전체 보기"로 잇는 곳이다.
//
// 뒤의 네 가지는 그 팀이 **무엇으로 참을 확립하는가**다 — 하네스·데이터셋·저지·스코어카드는 전부 레지스트리에
// `team_id` 를 들고 있으니(제어 평면이 `?team=` 으로 좁혀 준다) 이슈와 똑같이 팀이 소유한다. 예전에는 이것들이
// 워크스페이스 전역 목록에 `?team=` 을 붙여서만 좁혀졌는데, 그러면 "누구의 것인가"가 필터로 감춰진다.
export const TEAM_SECTIONS = [
  'issues',
  'triage',
  'cycles',
  'projects',
  'scorecards',
  'harnesses',
  'datasets',
  'judges',
] as const
export type TeamSection = (typeof TEAM_SECTIONS)[number]

// 그중 "이 팀이 무엇으로 평가하는가"에 답하는 것들 — 사이드바의 팀 그룹에서 한 마디(평가) 아래로 모인다.
// 순서가 곧 화면의 순서다: 결과(스코어카드)를 먼저 두고, 그 결과를 만든 재료를 뒤에 둔다.
export const TEAM_EVAL_SECTIONS = ['scorecards', 'harnesses', 'datasets', 'judges'] as const
export type TeamEvalSection = (typeof TEAM_EVAL_SECTIONS)[number]

// 팀 홈 — 이 팀이 지금 무엇을 하고 있나.
export function teamHref(workspace: string, key: string): string {
  return `/${workspace}/team/${encodeURIComponent(key)}`
}

// A team's own list of something — `/{workspace}/team/ENG/issues`. The team segment is singular because it
// addresses ONE team; the section stays plural because it is that team's collection.
export function teamSectionHref(workspace: string, key: string, section: TeamSection): string {
  return `${teamHref(workspace, key)}/${section}`
}

// A team's "create one of these" screen — `/{workspace}/team/ENG/scorecards/new`. Creating under the team's own
// address is what carries the owner: the same form at the workspace address has to infer whose it is, and the
// inference is exactly what put every batch in one team.
export function teamNewHref(workspace: string, key: string, section: TeamSection): string {
  return `${teamSectionHref(workspace, key, section)}/new`
}

// 팀 설정은 한 장이 아니라 리니어처럼 **탭 라우트**다 — 한 팀에게 묻는 질문이 여럿이고(누구인가 · 누가 있나 ·
// 일이 어떻게 흐르나 · 어떤 리듬으로 도나) 서로 상관이 없어서, 한 페이지에 쌓으면 지금 무엇을 고치는 중인지가
// 사라진다. 'general' 은 세그먼트가 없는 자리라 팀의 짧은 주소가 곧 일반 설정이다.
export const TEAM_SETTINGS_SECTIONS = ['general', 'members', 'workflow', 'cycles'] as const
export type TeamSettingsSection = (typeof TEAM_SETTINGS_SECTIONS)[number]

// 팀 설정(이름·키·로스터·보드) — 일하는 화면이 아니라 구성 화면이라 Settings 아래에 있지만, 주소는 같은 슬러그다.
export function teamSettingsHref(
  workspace: string,
  key: string,
  section: TeamSettingsSection = 'general'
): string {
  const base = `/${workspace}/settings/teams/${encodeURIComponent(key)}`
  return section === 'general' ? base : `${base}/${section}`
}

// 경로가 가리키는 팀 스코프. 팀의 짧은 주소(`/team/ENG`)는 그 팀의 이슈 화면이라 'issues' 로 읽는다 —
// 예전에는 별도의 요약 홈이 있어 'home' 이었지만, 지금은 같은 화면의 두 주소다. 팀 아래이긴 하지만 이름을 붙인 자원이
// 아니면 null 이다 — 그래도 그 팀의 화면이라는 사실은 변하지 않는다.
export interface TeamPathScope {
  key: string
  section: TeamSection | null
}

// href 빌더의 역방향 — 주소를 다시 팀 스코프로 읽는다. 이것이 "이 경로는 누구의 것인가"에 답하는 **유일한**
// 판정이어야 한다: 사이드바의 워크스페이스 나브와 팀 그룹이 각자 답하던 시절에는 `/teams` 행이 접두사만 보고
// 모든 팀 화면을 자기 것이라 주장해, 팀 하위 페이지마다 두 행이 동시에 활성화됐다.
// 정규식이 아니라 문자열로 자른다 — 워크스페이스 슬러그를 정규식에 끼워 넣으면 슬러그 안의 메타문자가 패턴이
// 되어 버린다.
export function matchTeamPath(pathname: string, workspace: string): TeamPathScope | null {
  const prefix = `/${workspace}/team/`
  if (!pathname.startsWith(prefix)) return null
  const segments = pathname.slice(prefix.length).split('/')
  // `/{workspace}/team` and `/{workspace}/team/` name no team at all, and `/{workspace}/teams` is the directory
  // of them — neither is one team's screen.
  const key = decodeSegment(segments[0])
  if (key === '') return null
  const rawSection = segments.length > 1 ? segments[1] : ''
  if (rawSection === '') return { key, section: 'issues' }
  // 자원 아래로 더 깊이 들어간 주소(상세 화면)도 여전히 그 자원의 것이다.
  // A detail under the team is spelled singular (`…/team/ENG/cycle/7` is ONE of `…/cycles`), so the singular is
  // read back to its collection — otherwise the section goes unrecognised and the team's nav row for it dims
  // exactly when someone opens one.
  const section = TEAM_SECTIONS.find(
    (candidate) => candidate === rawSection || candidate === pluralSegment(rawSection)
  )
  return { key, section: section ?? null }
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
