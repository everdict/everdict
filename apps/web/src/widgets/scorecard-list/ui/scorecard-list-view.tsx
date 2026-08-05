import { getTranslations } from 'next-intl/server'

import { TeamScopeBar, type TeamScope } from '@/widgets/team-scope-bar'
import { membersSchema } from '@/entities/member'
import { runnersResponseSchema } from '@/entities/runner'
import { scorecardsSchema } from '@/entities/scorecard'
import { teamNewHref, type TeamWithSummary } from '@/entities/team'
import { canInTeam } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { buttonVariants } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { Link } from '@/shared/ui/link'
import { PageHeader } from '@/shared/ui/page-header'

import { ScorecardList } from './scorecard-list'

// 배치 평가 결과 목록. ONE component behind TWO addresses: `/{workspace}/scorecards` (워크스페이스 전체)와
// `/{workspace}/teams/ENG/scorecards` (그 팀이 소유한 것). 소유권이 읽기에 하는 일은 필터이지 403 이 아니므로
// 팀 밖에서도 계속 보이고, 팀 주소는 "우리 팀이 무엇을 평가했나"에 답한다.
export async function ScorecardListView({
  workspace,
  team,
}: {
  workspace: string
  team?: TeamWithSummary
}) {
  const { principal, ctx } = await currentPrincipal()
  const t = await getTranslations('scorecardsPage')
  let error: string | undefined
  let scorecards = scorecardsSchema.parse([])
  try {
    scorecards = scorecardsSchema.parse(
      await controlPlane.listScorecards(ctx, team ? { team: team.id } : undefined)
    )
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  // Run-by name (members join) is supplementary info — the list itself shows even if it fails. (Same pattern as the dataset list)
  const members = await controlPlane
    .listMembers(ctx)
    .then((r) => membersSchema.parse(r))
    .catch(() => [])

  // For run-by display — subject → name + avatar (if any). Name is profile name > email local part > subject fallback.
  const authors: Record<string, { name: string; avatarUrl?: string }> = {}
  for (const m of members)
    authors[m.subject] = {
      name: m.name ?? m.email?.split('@')[0] ?? m.subject,
      ...(m.avatarUrl ? { avatarUrl: m.avatarUrl } : {}),
    }

  // Self-hosted runner device names for the per-row runtime chip — resolve self:<id> / self:ws:<id> to a friendly
  // label (bare pools self / self:ws carry no id, so they need no roster). Fetched only when some row names a specific
  // runner; best-effort like the members join, so a failed fetch just falls back to the raw runtime id.
  const runnerLabels: Record<string, string> = {}
  if (
    scorecards.some(
      (s) => s.runtime !== undefined && s.runtime.startsWith('self:') && s.runtime !== 'self:ws'
    )
  ) {
    try {
      const roster = runnersResponseSchema.parse(await controlPlane.listWorkspaceRunners(ctx))
      for (const r of roster.runners) runnerLabels[r.id] = r.label
    } catch {
      // roster fetch failed → the chip shows the raw runtime id
    }
  }

  const canRun = canInTeam(principal, 'scorecards:run', team?.id)
  // Row-trash gating info for the list: an admin deletes any terminal batch, a member only their own.
  const viewer = {
    ...(principal?.subject !== undefined ? { subject: principal.subject } : {}),
    admin: canInTeam(principal, 'scorecards:delete', team?.id),
  }
  const scope: TeamScope | undefined = team ? { workspace, team, section: 'scorecards' } : undefined

  return (
    <div className="space-y-6">
      {scope && <TeamScopeBar scope={scope} />}
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          canRun ? (
            <Link
              // Under a team, running starts at the TEAM's address so the batch is filed as that team's — the
              // workspace form would have to guess, and guessing is what put every batch in one team.
              href={
                team
                  ? teamNewHref(workspace, team.key, 'scorecards')
                  : `/${workspace}/scorecards/new`
              }
              className={buttonVariants({ size: 'sm' })}
            >
              {t('run')}
            </Link>
          ) : null
        }
      />

      {error ? (
        <Callout tone="danger">{t('connectError', { error })}</Callout>
      ) : scorecards.length === 0 ? (
        <EmptyState title={t('emptyTitle')} hint={t('emptyHint')} />
      ) : (
        <ScorecardList
          workspace={workspace}
          scorecards={scorecards}
          authors={authors}
          runnerLabels={runnerLabels}
          viewer={viewer}
        />
      )}
    </div>
  )
}
