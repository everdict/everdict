import { getTranslations } from 'next-intl/server'

import { teamsWithSummarySchema, type TeamWithSummary } from '@/entities/team'
import { TeamsManager } from '@/features/manage-team'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// Workspace › Teams — 이슈를 소유하고 이름 붙이는 그룹(docs/tracker.md).
// 읽기 teams:read(viewer+) / 생성·수정·삭제 teams:write(admin).
export default async function TeamsPage() {
  const t = await getTranslations('settingsNav')
  const s = await getTranslations('settingsPage')
  const { principal, ctx } = await currentPrincipal()
  const canRead = can(principal?.roles, 'teams:read')
  const canWrite = can(principal?.roles, 'teams:write')
  const header = <PageHeader title={t('teams')} description={t('teamsDesc')} />
  if (!canRead || !principal) {
    return (
      <div className="space-y-6">
        {header}
        <EmptyState title={s('noPermissionTitle')} hint={s('noPermissionHint')} />
      </div>
    )
  }

  let teams: TeamWithSummary[] = []
  let joinedTeamIds: string[] = []
  let error: string | undefined
  try {
    // 목록 읽기가 곧 불변식 복구 지점이다 — 팀이 하나도 없던 워크스페이스는 여기서 기본팀을 얻는다.
    // 내 로스터도 같이 읽는다 — 행마다 참여/나가기 컨트롤이 joined 를 서버 판정으로 받는다.
    const [all, mine] = await Promise.all([
      controlPlane.listTeams(ctx),
      controlPlane.listTeams(ctx, { mine: true }),
    ])
    teams = teamsWithSummarySchema.parse(all)
    joinedTeamIds = teamsWithSummarySchema.parse(mine).map((team) => team.id)
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  return (
    <div className="space-y-6">
      {header}
      {error !== undefined ? (
        <Callout tone="danger">{s('connectError', { error })}</Callout>
      ) : (
        <TeamsManager
          teams={teams}
          workspace={principal.workspace}
          canWrite={canWrite}
          canJoin={can(principal.roles, 'teams:join')}
          joinedTeamIds={joinedTeamIds}
        />
      )}
    </div>
  )
}
