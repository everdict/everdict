import { IssueListView, type IssueListFilters } from '@/widgets/issue-list'

import { redirectLegacyTeamScope } from '../team-scope'

export const dynamic = 'force-dynamic'

// 워크스페이스 전체의 이슈 — 모든 팀의 것. 한 팀의 이슈는 이 화면의 필터가 아니라 팀 아래의 자원이다
// (`/{workspace}/teams/ENG/issues`): 팀마다 가진 것이 다르므로 주소가 달라야 한다. `?team=` 이 붙은
// 예전 링크는 그 주소로 넘긴다.
export default async function IssuesPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>
  // 팀 스코프였던 예전 파라미터(`team`/`triage`)는 리다이렉트의 입력일 뿐이라 보기 어휘에 없다.
  searchParams: Promise<IssueListFilters & { team?: string; triage?: string }>
}) {
  const { workspace } = await params
  const search = await searchParams
  await redirectLegacyTeamScope({ workspace, section: 'issues', search })
  return <IssueListView workspace={workspace} filters={search} />
}
