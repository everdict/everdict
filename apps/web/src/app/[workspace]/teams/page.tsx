import { getTranslations } from 'next-intl/server'

import {
  teamHref,
  TeamKeyBadge,
  teamsWithSummarySchema,
  type TeamWithSummary,
} from '@/entities/team'
import { TeamJoinControl } from '@/features/manage-team'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Badge } from '@/shared/ui/badge'
import { buttonVariants } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { Link } from '@/shared/ui/link'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// Teams — the app-level DIRECTORY, not the settings screen. Two surfaces, two questions: this one answers
// "which teams exist and what are they working on" (teams:read = viewer+), Settings › Teams answers "create,
// rename, retire, and who is on the roster" (teams:write = admin). Sending a member to Settings just to look
// at the teams would hand the whole sidebar over to configuration for a read.
// 리니어의 "Join teams" 도 이 화면이다: 로스터에 없는 공개 팀은 여기서 스스로 참여한다(teams:join, member+).
export default async function TeamsDirectoryPage({
  params,
}: {
  params: Promise<{ workspace: string }>
}) {
  const { workspace } = await params
  const t = await getTranslations('teamsDirectory')
  const { principal, ctx } = await currentPrincipal()

  let teams: TeamWithSummary[] = []
  let joined = new Set<string>()
  let error: string | undefined
  try {
    // 전체 디렉터리와 내 로스터를 한 번에 — joined 판정은 서버 렌더의 것이다(클라이언트가 다시 세지 않는다).
    const [all, mine] = await Promise.all([
      controlPlane.listTeams(ctx),
      controlPlane.listTeams(ctx, { mine: true }),
    ])
    teams = teamsWithSummarySchema.parse(all)
    joined = new Set(teamsWithSummarySchema.parse(mine).map((team) => team.id))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  const canManage = can(principal?.roles, 'teams:write')
  const canJoin = can(principal?.roles, 'teams:join')

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('title')}
        description={t('description')}
        {...(canManage
          ? {
              actions: (
                <Link
                  href={`/${workspace}/settings/teams`}
                  className={buttonVariants({ variant: 'outline', size: 'sm' })}
                >
                  {t('manage')}
                </Link>
              ),
            }
          : {})}
      />

      {error && <Callout tone="danger">{error}</Callout>}

      {teams.length === 0 && !error ? (
        <EmptyState title={t('empty')} hint={canManage ? t('emptyHintAdmin') : t('emptyHint')} />
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border bg-card">
          {teams.map((team) => (
            <li key={team.id} className="flex items-center gap-3 pr-3 hover:bg-accent/40">
              {/* 이름 영역이 드릴인이고 참여 컨트롤은 그 형제다 — 행 전체를 링크로 만들면 버튼이 그 안에 갇힌다. */}
              <Link
                href={teamHref(workspace, team.key)}
                className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5"
              >
                <TeamKeyBadge teamKey={team.key} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-[510]">{team.name}</span>
                    {team.isDefault && <Badge tone="outline">{t('default')}</Badge>}
                  </span>
                  {team.description && (
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                      {team.description}
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {t('rowSummary', {
                    members: team.summary.memberCount,
                    open: team.summary.openIssues,
                  })}
                </span>
              </Link>
              {canJoin && (
                <span className="shrink-0">
                  <TeamJoinControl teamId={team.id} joined={joined.has(team.id)} />
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
