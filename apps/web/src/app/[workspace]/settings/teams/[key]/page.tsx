import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'

import { TeamDetailManager, WorkflowStatesEditor } from '@/features/manage-team'
import { membersSchema, type Member } from '@/entities/member'
import {
  teamMembersSchema,
  teamsWithSummarySchema,
  teamWithSummarySchema,
  type TeamMember,
  type TeamWithSummary,
} from '@/entities/team'
import { workflowStatesSchema, type WorkflowState } from '@/entities/workflow-state'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'
import { InfoTip } from '@/shared/ui/tooltip'

export const dynamic = 'force-dynamic'

// Workspace › Teams › {team} — 팀 일반 설정 + 로스터. 팀 멤버십은 워크스페이스 멤버십과 별도라,
// 추가 후보는 워크스페이스 멤버 목록에서 온다(팀에 이미 있는 사람은 뺀다).
export default async function TeamDetailPage({
  params,
}: {
  // 팀은 키로 주소를 갖는다(`/settings/teams/ENG`) — 일하는 화면과 같은 슬러그다. 제어 평면이 id 도 받으므로
  // 예전 uuid 링크는 그대로 열린다.
  params: Promise<{ workspace: string; key: string }>
}) {
  const { key } = await params
  const s = await getTranslations('settingsPage')
  const { principal, ctx } = await currentPrincipal()
  const canRead = can(principal?.roles, 'teams:read')
  const canWrite = can(principal?.roles, 'teams:write')
  if (!canRead || !principal) {
    return (
      <div className="space-y-6">
        <EmptyState title={s('noPermissionTitle')} hint={s('noPermissionHint')} />
      </div>
    )
  }

  let team: TeamWithSummary
  let members: TeamMember[] = []
  let siblings: TeamWithSummary[] = []
  let states: WorkflowState[] = []
  let workspaceMembers: Member[] = []
  let error: string | undefined
  try {
    team = teamWithSummarySchema.parse(await controlPlane.getTeam(ctx, decodeURIComponent(key)))
    members = teamMembersSchema.parse(await controlPlane.listTeamMembers(ctx, team.id))
    siblings = teamsWithSummarySchema.parse(await controlPlane.listTeams(ctx))
    // 보드 — 팀이 자기 워크플로의 자리들에 붙인 이름. 없으면 서버가 기본 여섯을 심어서 준다.
    states = workflowStatesSchema.parse(await controlPlane.listWorkflowStates(ctx, team.id))
    if (can(principal.roles, 'members:read'))
      workspaceMembers = membersSchema.parse(await controlPlane.listMembers(ctx))
  } catch (e) {
    // 다른 워크스페이스의 팀은 404 로 읽힌다(존재 여부를 흘리지 않는다).
    const message = e instanceof Error ? e.message : String(e)
    if (message.includes('404') || message.toLowerCase().includes('not found')) notFound()
    error = message
    return (
      <div className="space-y-6">
        <Callout tone="danger">{s('connectError', { error })}</Callout>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <PageHeader title={team.name} description={team.description ?? undefined} />
      <section className="space-y-3">
        <h2 className="flex items-center gap-1.5 text-[13px] font-[510] text-foreground">
          {s('teamStatesTitle')}
          <InfoTip content={s('teamStatesTip')} />
        </h2>
        <WorkflowStatesEditor teamId={team.id} states={states} canWrite={canWrite} />
      </section>

      <TeamDetailManager
        team={team}
        members={members}
        parents={siblings
          .filter((x) => x.id !== team.id)
          .map((x) => ({ value: x.id, label: `${x.key} · ${x.name}` }))}
        candidates={workspaceMembers.map((m) => ({
          value: m.subject,
          label: m.name ?? m.email ?? m.subject,
        }))}
        directory={Object.fromEntries(
          workspaceMembers.map((m) => [m.subject, { name: m.name ?? m.email ?? m.subject }])
        )}
        workspace={principal.workspace}
        canWrite={canWrite}
      />
    </div>
  )
}
