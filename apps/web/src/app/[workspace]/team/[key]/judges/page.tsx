import { JudgeListView } from '@/widgets/judge-list'

import { loadTeamScope } from '../../../team-scope'

export const dynamic = 'force-dynamic'

// 이 팀이 소유한 저지 — `/{workspace}/teams/ENG/judges`.
export default async function TeamJudgesPage({
  params,
}: {
  params: Promise<{ workspace: string; key: string }>
}) {
  const { workspace, key } = await params
  const team = await loadTeamScope({ workspace, slug: key, section: 'judges' })
  return <JudgeListView workspace={workspace} team={team} />
}
