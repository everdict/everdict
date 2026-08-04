import { notFound } from 'next/navigation'

import { CycleBoardView } from '@/widgets/cycle-board'
import { type IssueListFilters } from '@/widgets/issue-list'

import { loadTeamScope } from '../../../../team-scope'

export const dynamic = 'force-dynamic'

// 한 이터레이션 — `/{workspace}/teams/ENG/cycles/7`. 슬러그가 번호인 이유는 이슈가 identifier 로 주소를
// 갖는 것과 같다: "Cycle 7"은 사람들이 그 사이클을 부르는 이름이고, uuid 는 아니다. 팀 키가 앞에 있으므로
// 누구의 일곱 번째인지도 주소가 답한다.
export default async function CycleNumberPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; key: string; number: string }>
  searchParams: Promise<IssueListFilters>
}) {
  const { workspace, key, number } = await params
  const search = await searchParams
  const team = await loadTeamScope({ workspace, slug: key, section: 'cycles', search })
  // 번호가 아닌 슬러그는 이 팀의 어떤 사이클도 아니다 — 보드가 "없는 번호"를 그리기 전에 여기서 끝낸다.
  const parsed = Number(number)
  if (!Number.isInteger(parsed) || parsed < 1) notFound()
  return <CycleBoardView workspace={workspace} team={team} number={parsed} filters={search} />
}
