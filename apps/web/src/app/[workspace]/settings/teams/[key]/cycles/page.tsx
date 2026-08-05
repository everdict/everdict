import { TeamCyclesForm } from '@/features/manage-team'

import { loadTeamSettings } from '../load-team'

export const dynamic = 'force-dynamic'

// 사이클 — 이 팀이 이터레이션으로 도는지, 돈다면 어떤 리듬으로. 켜는 순간부터 사이클 목록을 읽을 때마다
// "지금 있는 하나 + 예정 N개"가 세워지므로, 아래 줄들은 그때 세워질 창의 모양이다.
export default async function TeamCyclesSettingsPage({
  params,
}: {
  params: Promise<{ workspace: string; key: string }>
}) {
  const { key } = await params
  const { team, canWrite } = await loadTeamSettings(key)
  if (!team) return null

  return <TeamCyclesForm team={team} canWrite={canWrite} />
}
