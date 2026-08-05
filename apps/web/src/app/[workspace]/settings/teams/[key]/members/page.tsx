import { getTranslations } from 'next-intl/server'

import { TeamRoster } from '@/features/manage-team'
import { memberDirectoryOf, membersSchema, type Member } from '@/entities/member'
import { teamMembersSchema, type TeamMember } from '@/entities/team'
import { can } from '@/shared/auth/can'
import { controlPlane } from '@/shared/lib/control-plane'
import { Callout } from '@/shared/ui/callout'
import { InfoTip } from '@/shared/ui/tooltip'

import { loadTeamSettings } from '../load-team'

export const dynamic = 'force-dynamic'

// 멤버 — 이 팀의 로스터. 팀 멤버십은 워크스페이스 멤버십과 별도라, 추가 후보는 워크스페이스 멤버 목록에서 온다.
export default async function TeamMembersSettingsPage({
  params,
}: {
  params: Promise<{ workspace: string; key: string }>
}) {
  const { key } = await params
  const t = await getTranslations('manageTeams')
  const s = await getTranslations('settingsPage')
  const { team, principal, ctx, canWrite } = await loadTeamSettings(key)
  if (!team || !principal) return null

  let members: TeamMember[] = []
  let workspaceMembers: Member[] = []
  let error: string | undefined
  try {
    members = teamMembersSchema.parse(await controlPlane.listTeamMembers(ctx, team.id))
    if (can(principal.roles, 'members:read'))
      workspaceMembers = membersSchema.parse(await controlPlane.listMembers(ctx))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  if (error !== undefined) return <Callout tone="danger">{s('connectError', { error })}</Callout>

  return (
    <div className="space-y-3">
      {/* 팀 소속은 권한이 아니다 — 도메인이 "가시성·소유의 진술이지 두 번째 인가 축이 아니다" 라고 못박고
          있고, 멤버 목록 바로 위에 있는 이 줄에서 그 구분을 말해주지 않으면 여기서 권한을 준다고 읽힌다. */}
      <p className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
        {t('rosterHint')}
        <InfoTip content={t('rosterPermissionTip')} />
      </p>
      <TeamRoster
        teamId={team.id}
        members={members}
        candidates={workspaceMembers.map((m) => ({
          value: m.subject,
          label: m.name ?? m.email ?? m.subject,
        }))}
        directory={memberDirectoryOf(workspaceMembers)}
        canWrite={canWrite}
      />
    </div>
  )
}
