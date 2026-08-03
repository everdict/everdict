import { IssueListView, type IssueListFilters } from '@/widgets/issue-list'

import { loadTeamScope } from '../../../team-scope'

export const dynamic = 'force-dynamic'

// 한 팀의 이슈 — `/{workspace}/teams/ENG/issues`. 워크스페이스 전체 목록(`/issues`)과 같은 컴포넌트를
// 그리지만 다른 자원이다: 팀마다 가진 것이 다르고, 주소가 그 사실을 말해야 한다.
export default async function TeamIssuesPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; key: string }>
  searchParams: Promise<IssueListFilters>
}) {
  const { workspace, key } = await params
  const search = await searchParams
  const team = await loadTeamScope({ workspace, slug: key, section: 'issues', search })
  return <IssueListView workspace={workspace} team={team} filters={search} />
}
