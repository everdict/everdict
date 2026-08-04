import { HarnessListView } from '@/widgets/harness-list'

import { redirectLegacyTeamScope } from '../team-scope'

export const dynamic = 'force-dynamic'

// 워크스페이스 전체의 하네스. 한 팀이 소유한 것만 보려면 팀 아래의 주소를 쓴다
// (`/{workspace}/teams/ENG/harnesses`) — `?team=` 이 붙은 예전 링크는 그리로 넘긴다.
export default async function HarnessesPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>
  searchParams: Promise<{ team?: string }>
}) {
  const { workspace } = await params
  const search = await searchParams
  await redirectLegacyTeamScope({ workspace, section: 'harnesses', search })
  return <HarnessListView workspace={workspace} />
}
