import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'

import { TeamDetailManager } from '@/features/manage-team'
import { membersSchema, type Member } from '@/entities/member'
import {
  teamMembersSchema,
  teamWithSummarySchema,
  type TeamMember,
  type TeamWithSummary,
} from '@/entities/team'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// Workspace › Teams › {team} — 팀 일반 설정 + 로스터. 팀 멤버십은 워크스페이스 멤버십과 별도라,
// 추가 후보는 워크스페이스 멤버 목록에서 온다(팀에 이미 있는 사람은 뺀다).
export default async function TeamDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
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
  let workspaceMembers: Member[] = []
  let error: string | undefined
  try {
    team = teamWithSummarySchema.parse(await controlPlane.getTeam(ctx, id))
    members = teamMembersSchema.parse(await controlPlane.listTeamMembers(ctx, id))
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
      <TeamDetailManager
        team={team}
        members={members}
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
