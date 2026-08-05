import { getTranslations } from 'next-intl/server'

import { membersSchema } from '@/entities/member'
import { runnersResponseSchema } from '@/entities/runner'
import {
  DEFAULT_SCORECARD_DISPLAY,
  SCORECARD_FACETS,
  SCORECARD_GROUPINGS,
  SCORECARD_ORDERS,
  scorecardsSchema,
} from '@/entities/scorecard'
import { teamsSchema, withResolvedTeamFilter, type Team } from '@/entities/team'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { loadListViewScope } from '@/shared/lib/load-list-view'
import { buttonVariants } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { Link } from '@/shared/ui/link'
import { PageHeader } from '@/shared/ui/page-header'

import { ScorecardList } from './scorecard-list'

// 배치 평가 결과 목록 — 워크스페이스 하나의 주소다. 소유 팀은 레지스트리에 남아 "누가 고칠 수 있나"를
// 정하되, 찾아가는 길은 하나이고 "우리 팀 것만"은 이 목록의 필터 한 축이다.
export async function ScorecardListView({
  workspace,
  params,
}: {
  workspace: string
  params: Record<string, string | string[] | undefined>
}) {
  const { principal, ctx } = await currentPrincipal()
  const t = await getTranslations('scorecardsPage')
  let error: string | undefined
  let scorecards = scorecardsSchema.parse([])
  try {
    scorecards = scorecardsSchema.parse(await controlPlane.listScorecards(ctx))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  // Run-by name (members join) is supplementary info — the list itself shows even if it fails. (Same pattern as the dataset list)
  const members = await controlPlane
    .listMembers(ctx)
    .then((r) => membersSchema.parse(r))
    .catch(() => [])
  // 팀 축의 이름표 — 실패하면 그 축만 조용히 사라진다.
  const teams = await controlPlane
    .listTeams(ctx)
    .then((r) => teamsSchema.parse(r))
    .catch((): Team[] => [])

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

  const canRun = can(principal?.roles, 'scorecards:run')
  // Row-trash gating info for the list: an admin deletes any terminal batch, a member only their own.
  const viewer = {
    ...(principal?.subject !== undefined ? { subject: principal.subject } : {}),
    admin: can(principal?.roles, 'scorecards:delete'),
  }

  const scope = await loadListViewScope({
    basePath: `/${workspace}/scorecards`,
    viewKey: 'scorecards',
    facets: SCORECARD_FACETS,
    vocabulary: {
      groupings: SCORECARD_GROUPINGS,
      orders: SCORECARD_ORDERS,
      fallback: DEFAULT_SCORECARD_DISPLAY,
    },
    params,
  })

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          canRun ? (
            <Link href={`/${workspace}/scorecards/new`} className={buttonVariants({ size: 'sm' })}>
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
          teams={teams.map((team) => ({ id: team.id, key: team.key, name: team.name }))}
          scope={{ ...scope, filters: withResolvedTeamFilter(scope.filters, teams) }}
          viewer={viewer}
        />
      )}
    </div>
  )
}
