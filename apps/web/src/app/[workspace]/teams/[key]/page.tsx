import { IssueListView, type IssueListFilters } from '@/widgets/issue-list'

import { loadTeamScope } from '../../team-scope'

export const dynamic = 'force-dynamic'

// 팀을 열면 곧바로 그 팀의 이슈다 — 리니어와 같은 착지점이고, 같은 이유다: 팀 화면에서 하는 일은 이슈를
// 보는 것이지 팀을 읽는 것이 아니다. `…/issues` 는 같은 화면의 정규 주소로 남는다(둘이 한 컴포넌트인 것이
// 핵심 — 목록을 복제해 스코프를 붙이는 것이 두 사본이 어긋나는 방식이다).
//
// 팀의 요약(열린 이슈 수·멤버 수)은 여기 있던 자리에서 사라졌다: 사이드바와 팀 디렉터리가 이미 그 숫자를
// 들고 있고, 화면 맨 위의 그룹 헤더가 같은 사실을 더 정확하게 말한다. 팀 *설정*(이름·키·로스터)은 계속
// Settings › Teams 가 소유한다.
export default async function TeamHomePage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; key: string }>
  searchParams: Promise<IssueListFilters>
}) {
  const { workspace, key } = await params
  const search = await searchParams
  const team = await loadTeamScope({ workspace, slug: key, search })
  return <IssueListView workspace={workspace} team={team} filters={search} />
}
