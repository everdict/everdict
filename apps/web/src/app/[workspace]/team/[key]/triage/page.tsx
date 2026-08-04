import { notFound } from 'next/navigation'

import { IssueListView, type IssueListFilters } from '@/widgets/issue-list'

import { loadTeamScope } from '../../../team-scope'

export const dynamic = 'force-dynamic'

// 팀의 트리아지 인박스 — 워크플로 앞에 앉은 큐. 이슈 목록의 필터가 아니라 그 팀 아래의 자원이라 자기 주소를
// 갖는다. 큐를 켜지 않은 팀에는 존재하지 않으므로 404 다: 열어 봐야 영원히 비어 있는 화면을 주소로 만들지 않는다.
export default async function TeamTriagePage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; key: string }>
  searchParams: Promise<IssueListFilters>
}) {
  const { workspace, key } = await params
  const search = await searchParams
  const team = await loadTeamScope({ workspace, slug: key, section: 'triage', search })
  if (!team.triageEnabled) notFound()
  return <IssueListView workspace={workspace} team={team} triage filters={search} />
}
