import { TeamGeneralForm } from '@/features/manage-team'
import { teamsWithSummarySchema, type TeamWithSummary } from '@/entities/team'
import { controlPlane } from '@/shared/lib/control-plane'

import { loadTeamSettings } from './load-team'

export const dynamic = 'force-dynamic'

// 일반 — 이 팀이 무엇인가(키·이름·설명·상위 팀), 누가 볼 수 있나, 어디가 기본인가, 그리고 삭제.
export default async function TeamGeneralSettingsPage({
  params,
}: {
  params: Promise<{ workspace: string; key: string }>
}) {
  const { workspace, key } = await params
  const { team, ctx, canWrite } = await loadTeamSettings(key)
  // 레이아웃이 이미 실패를 그렸다 — 같은 말을 두 번 하지 않는다.
  if (!team) return null

  let siblings: TeamWithSummary[] = []
  try {
    siblings = teamsWithSummarySchema.parse(await controlPlane.listTeams(ctx))
  } catch {
    // 상위 팀 후보를 못 읽어도 이름·설명은 고칠 수 있어야 한다 — 콤보박스만 비워 둔다.
    siblings = []
  }

  return (
    <TeamGeneralForm
      team={team}
      parents={siblings
        .filter((x) => x.id !== team.id)
        .map((x) => ({ value: x.id, label: `${x.key} · ${x.name}` }))}
      workspace={workspace}
      canWrite={canWrite}
    />
  )
}
