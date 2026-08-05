import { getTranslations } from 'next-intl/server'

import { TeamTriageForm, WorkflowStatesEditor } from '@/features/manage-team'
import { workflowStatesSchema, type WorkflowState } from '@/entities/workflow-state'
import { controlPlane } from '@/shared/lib/control-plane'
import { Callout } from '@/shared/ui/callout'
import { InfoTip } from '@/shared/ui/tooltip'

import { loadTeamSettings } from '../load-team'

export const dynamic = 'force-dynamic'

// 워크플로 — 일이 이 팀을 어떻게 통과하는가. 트리아지가 그 앞의 큐이고(docs/tracker.md), 이슈 상태가 그 안의
// 자리들이다. 자리(정규 상태)는 닫힌 어휘이고, 팀이 고르는 것은 그 자리에 붙일 이름·색·순서다.
export default async function TeamWorkflowSettingsPage({
  params,
}: {
  params: Promise<{ workspace: string; key: string }>
}) {
  const { key } = await params
  const s = await getTranslations('settingsPage')
  const { team, ctx, canWrite } = await loadTeamSettings(key)
  if (!team) return null

  let states: WorkflowState[] = []
  let error: string | undefined
  try {
    // 보드 — 팀이 자기 워크플로의 자리들에 붙인 이름. 없으면 서버가 기본 여섯을 심어서 준다.
    states = workflowStatesSchema.parse(await controlPlane.listWorkflowStates(ctx, team.id))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  return (
    <div className="space-y-6">
      <TeamTriageForm teamId={team.id} enabled={team.triageEnabled} canWrite={canWrite} />

      <section className="space-y-3">
        <h2 className="flex items-center gap-1.5 text-[13px] font-[510] text-foreground">
          {s('teamStatesTitle')}
          <InfoTip content={s('teamStatesTip')} />
        </h2>
        {error !== undefined ? (
          <Callout tone="danger">{s('connectError', { error })}</Callout>
        ) : (
          <WorkflowStatesEditor teamId={team.id} states={states} canWrite={canWrite} />
        )}
      </section>
    </div>
  )
}
