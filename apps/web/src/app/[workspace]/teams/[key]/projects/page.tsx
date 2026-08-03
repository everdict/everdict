import { ProjectListView } from '@/widgets/project-list'

import { loadTeamScope } from '../../../team-scope'

export const dynamic = 'force-dynamic'

// 이 팀이 하고 있는 프로젝트 — `/{workspace}/teams/ENG/projects`. 프로젝트는 여러 팀의 것일 수 있으므로
// 워크스페이스 목록도 그대로 남는다(같은 컴포넌트, 다른 주소).
export default async function TeamProjectsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; key: string }>
  searchParams: Promise<{ status?: string; initiative?: string }>
}) {
  const { workspace, key } = await params
  const search = await searchParams
  const team = await loadTeamScope({ workspace, slug: key, section: 'projects', search })
  return <ProjectListView workspace={workspace} team={team} filters={search} />
}
