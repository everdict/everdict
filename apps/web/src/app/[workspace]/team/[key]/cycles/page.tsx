import { CycleBoardView } from '@/widgets/cycle-board'
import { type IssueListFilters } from '@/widgets/issue-list'

import { loadTeamScope } from '../../../team-scope'

export const dynamic = 'force-dynamic'

// 팀의 이터레이션 — `/{workspace}/teams/ENG/cycles`. 사이클은 언제나 한 팀의 것이라("Cycle 3"은 그 팀의
// 세 번째다) 워크스페이스 수준의 주소가 없다.
//
// 이 주소는 목록이 아니라 **지금 돌고 있는 사이클**이다(리니어의 랜딩). 「사이클」을 누르는 사람이 알고 싶은
// 것은 언제나 이번 주기의 상태이고, 목록은 그 질문에 한 번 더 눌러야 답한다. 전체 목록은 `…/cycles/all`,
// 특정 이터레이션은 `…/cycles/7` 이 자기 주소로 갖는다.
export default async function TeamCyclesPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; key: string }>
  searchParams: Promise<IssueListFilters>
}) {
  const { workspace, key } = await params
  const search = await searchParams
  const team = await loadTeamScope({ workspace, slug: key, section: 'cycles', search })
  return <CycleBoardView workspace={workspace} team={team} filters={search} />
}
