import { getTranslations } from 'next-intl/server'

import {
  teamHref,
  TeamKeyBadge,
  teamsWithSummarySchema,
  type TeamWithSummary,
} from '@/entities/team'
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
export default async function TeamsDirectoryPage({
  params,
}: {
  params: Promise<{ workspace: string }>
}) {
  const { workspace } = await params
  const t = await getTranslations('teamsDirectory')
  const { principal, ctx } = await currentPrincipal()

  let teams: TeamWithSummary[] = []
  let error: string | undefined
  try {
    teams = teamsWithSummarySchema.parse(await controlPlane.listTeams(ctx))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  const canManage = can(principal?.roles, 'teams:write')

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
            <li key={team.id}>
              {/* 행 전체가 팀 홈으로 — 리스트의 행이 엔티티면 이름이 곧 드릴인이다. */}
              <Link
                href={teamHref(workspace, team.key)}
                className="flex items-center gap-3 px-3 py-2.5 hover:bg-accent/40"
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
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
