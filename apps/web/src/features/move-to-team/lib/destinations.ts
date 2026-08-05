import { canInTeam, type WebAction } from '@/shared/auth/can'

import type { TeamOption } from '../ui/team-owner-control'

export interface TeamMoveOptions {
  // 이 화면이 이름 붙일 수 있는 팀 전부. 읽기는 로스터의 일이 아니므로(비공개 팀만 애초에 도착하지 않는다)
  // 내가 속하지 않은 팀이 소유한 자원도 그 팀의 키로 읽힌다.
  teams: TeamOption[]
  // 이 사람이 실제로 앞에 세울 수 있는 팀. 제어 평면과 같은 규칙이다 — 관리자는 전부, 그 외에는 자기 팀.
  writableIds: string[]
}

// 화면이 제공할 선택지를 서버 규칙 그대로 계산한다. `moveCapabilityToTeam` 은 출발 팀과 도착 팀을 둘 다
// 인가하므로, 화면도 같은 두 조건을 본다 — 넓게 그려 놓고 403 을 받는 메뉴는 고를 수 있다는 거짓말이다.
export function moveDestinationsFor(
  principal: { roles?: string[]; teams?: string[] } | null | undefined,
  teams: { id: string; key: string; name: string }[],
  action: WebAction
): TeamMoveOptions {
  const options: TeamOption[] = teams.map((team) => ({
    id: team.id,
    key: team.key,
    name: team.name,
  }))
  return {
    teams: options,
    writableIds: options.filter((team) => canInTeam(principal, action, team.id)).map((t) => t.id),
  }
}
