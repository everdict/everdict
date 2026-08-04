import { ScorecardListView } from '@/widgets/scorecard-list'

import { loadTeamScope } from '../../../team-scope'

export const dynamic = 'force-dynamic'

// 이 팀이 소유한 배치 평가 — `/{workspace}/teams/ENG/scorecards`. 소유권이 읽기에 하는 일은 필터이지 403 이
// 아니므로 워크스페이스 목록에서도 계속 보인다.
export default async function TeamScorecardsPage({
  params,
}: {
  params: Promise<{ workspace: string; key: string }>
}) {
  const { workspace, key } = await params
  const team = await loadTeamScope({ workspace, slug: key, section: 'scorecards' })
  return <ScorecardListView workspace={workspace} team={team} />
}
