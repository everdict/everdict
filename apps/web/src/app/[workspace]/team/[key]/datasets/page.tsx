import { DatasetListView } from '@/widgets/dataset-list'

import { loadTeamScope } from '../../../team-scope'

export const dynamic = 'force-dynamic'

// 이 팀이 소유한 데이터셋 — `/{workspace}/teams/ENG/datasets`.
export default async function TeamDatasetsPage({
  params,
}: {
  params: Promise<{ workspace: string; key: string }>
}) {
  const { workspace, key } = await params
  const team = await loadTeamScope({ workspace, slug: key, section: 'datasets' })
  return <DatasetListView workspace={workspace} team={team} />
}
