import { CycleListView } from '@/widgets/cycle-list'

import { loadTeamScope } from '../../../team-scope'

export const dynamic = 'force-dynamic'

// 팀의 이터레이션 — `/{workspace}/teams/ENG/cycles`. 사이클은 언제나 한 팀의 것이라("Cycle 3"은 그 팀의
// 세 번째다) 워크스페이스 수준의 주소가 없다.
export default async function TeamCyclesPage({
  params,
}: {
  params: Promise<{ workspace: string; key: string }>
}) {
  const { workspace, key } = await params
  const team = await loadTeamScope({ workspace, slug: key, section: 'cycles' })
  return <CycleListView workspace={workspace} team={team} />
}
