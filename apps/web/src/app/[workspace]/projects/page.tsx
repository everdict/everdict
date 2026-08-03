import { ProjectListView } from '@/widgets/project-list'

import { redirectLegacyTeamScope } from '../team-scope'

export const dynamic = 'force-dynamic'

// 워크스페이스 전체의 프로젝트. 한 팀이 하고 있는 것만 보려면 팀 아래의 주소를 쓴다
// (`/{workspace}/teams/ENG/projects`) — `?team=` 이 붙은 예전 링크는 그리로 넘긴다.
export default async function ProjectsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>
  searchParams: Promise<{ status?: string; initiative?: string; team?: string }>
}) {
  const { workspace } = await params
  const search = await searchParams
  await redirectLegacyTeamScope({ workspace, section: 'projects', search })
  return <ProjectListView workspace={workspace} filters={search} />
}
