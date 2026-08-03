import 'server-only'

import { notFound, redirect } from 'next/navigation'

import {
  teamHref,
  teamNewHref,
  teamSectionHref,
  teamWithSummarySchema,
  type TeamSection,
  type TeamWithSummary,
} from '@/entities/team'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// `/{workspace}/teams/{key}/…` 아래 모든 화면의 진입 절차. 세 가지를 한곳에서 한다.
//
// ① 슬러그 해석 — 제어 평면의 /teams/:ref 는 키와 id 를 모두 받으므로, 팀이 도입되기 전에 퍼진 uuid 링크도
//    계속 열린다. ② 정규화 — 해석된 팀의 키가 주소와 다르면(uuid 였거나 소문자였다) 정식 주소로 리다이렉트한다.
//    이슈 상세가 identifier 로 정규화하는 것과 같은 처리이고, 그래야 사람이 복사해 붙이는 링크가 한 형태로 모인다.
// ③ 접근 판정 — 없는 팀도, 볼 수 없는 팀도 404 다. 존재 여부를 흘리지 않는 쪽이 제어 평면의 규칙이고, 웹은
//    그 답을 그대로 옮긴다(읽기 권한 자체는 제어 평면이 강제한다 — 여기서 다시 판정하지 않는다).
export async function loadTeamScope(input: {
  workspace: string
  slug: string
  // 팀 홈이면 생략. 섹션이면 정규화 리다이렉트가 그 섹션으로 돌아간다.
  section?: TeamSection
  // The section's "new" screen (`…/scorecards/new`). Without it a normalizing redirect would land on the LIST and
  // silently throw away the form the person opened — the slug is fixed, but so is what they were doing.
  create?: boolean
  // 정규화 리다이렉트가 살려 둘 쿼리(상태·우선순위 필터). 팀은 여기 없다 — 경로가 말한다.
  search?: Record<string, string | string[] | undefined>
}): Promise<TeamWithSummary> {
  const { workspace, slug, section, create, search } = input
  const ctx = await authContext()

  let team: TeamWithSummary
  try {
    team = teamWithSummarySchema.parse(await controlPlane.getTeam(ctx, decodeURIComponent(slug)))
  } catch {
    // 없는 팀 · 다른 워크스페이스의 팀 · 볼 수 없는 팀 — 전부 같은 답.
    notFound()
  }

  if (decodeURIComponent(slug) !== team.key) {
    const base =
      section === undefined
        ? teamHref(workspace, team.key)
        : create
          ? teamNewHref(workspace, team.key, section)
          : teamSectionHref(workspace, team.key, section)
    const qs = queryString(search)
    redirect(`${base}${qs ? `?${qs}` : ''}`)
  }
  return team
}

// 예전 주소를 새 주소로 넘긴다 — `/{workspace}/issues?team=<uuid>` → `/{workspace}/teams/ENG/issues`.
// 팀 스코프가 쿼리 파라미터였던 시절의 링크(북마크·붙여넣은 채팅·에이전트가 만든 링크)가 죽지 않게 하는 게
// 전부다. `team` 이 없으면 아무것도 하지 않는다(그건 워크스페이스 전체 목록이라는 뜻이다).
export async function redirectLegacyTeamScope(input: {
  workspace: string
  section: TeamSection
  search: Record<string, string | string[] | undefined>
}): Promise<void> {
  const { workspace, section, search } = input
  const ref = typeof search.team === 'string' ? search.team : undefined
  if (ref === undefined) return
  const ctx = await authContext()
  let team: TeamWithSummary
  try {
    team = teamWithSummarySchema.parse(await controlPlane.getTeam(ctx, ref))
  } catch {
    notFound() // 사라진 팀을 가리키는 링크 — 워크스페이스 전체 목록으로 조용히 넓히지 않는다
  }
  // 트리아지는 이제 자기 자원이다(`…/triage`), 이슈 목록의 플래그가 아니다.
  const target = section === 'issues' && search.triage === 'true' ? 'triage' : section
  const rest = { ...search }
  delete rest.team
  delete rest.triage
  const qs = queryString(rest)
  redirect(`${teamSectionHref(workspace, team.key, target)}${qs ? `?${qs}` : ''}`)
}

function queryString(search?: Record<string, string | string[] | undefined>): string {
  if (!search) return ''
  const q = new URLSearchParams()
  for (const [key, value] of Object.entries(search)) {
    if (value === undefined) continue
    for (const one of Array.isArray(value) ? value : [value]) q.append(key, one)
  }
  return q.toString()
}
