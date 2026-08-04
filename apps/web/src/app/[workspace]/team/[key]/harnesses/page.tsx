import { HarnessListView } from '@/widgets/harness-list'

import { loadTeamScope } from '../../../team-scope'

export const dynamic = 'force-dynamic'

// 이 팀이 소유한 하네스 — `/{workspace}/teams/ENG/harnesses`. 소유권이 읽기에 하는 일은 필터이지 403 이
// 아니므로 워크스페이스 목록에서도 계속 보인다.
export default async function TeamHarnessesPage({
  params,
}: {
  params: Promise<{ workspace: string; key: string }>
}) {
  const { workspace, key } = await params
  const team = await loadTeamScope({ workspace, slug: key, section: 'harnesses' })
  return <HarnessListView workspace={workspace} team={team} />
}
