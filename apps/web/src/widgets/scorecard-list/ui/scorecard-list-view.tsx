import { getTranslations } from 'next-intl/server'

import { loadScorecardViewData } from '@/features/browse-scorecards/server'
import { membersSchema } from '@/entities/member'
import { runnersResponseSchema } from '@/entities/runner'
import {
  DEFAULT_SCORECARD_DISPLAY,
  SCORECARD_FACETS,
  SCORECARD_GROUPINGS,
  SCORECARD_ORDERS,
  scorecardGroupCountsSchema,
} from '@/entities/scorecard'
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

// The batch evaluation result list — one address per workspace. The owning team remains in the registry and decides "who may edit it", while
// there is ONE route to find things and "only our team's" is one filter axis on this list.
export async function ScorecardListView({
  workspace,
  params,
}: {
  workspace: string
  params: Record<string, string | string[] | undefined>
}) {
  const { principal, ctx } = await currentPrincipal()
  const t = await getTranslations('scorecardsPage')

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

  // The list's first paint, and the workspace tiles. They are separate reads on purpose: the tiles answer
  // "what does this workspace have" — a question a filter must not change — so they are counted ONCE,
  // unnarrowed, while the list below is narrowed by whatever the address says.
  const view = {
    filters: scope.filters,
    search: scope.search,
    display: scope.display,
  }
  const [data, statusCounts] = await Promise.all([
    loadScorecardViewData(ctx, view),
    controlPlane
      .countScorecards(ctx, 'status')
      .then((r) => scorecardGroupCountsSchema.parse(r))
      .catch(() => undefined),
  ])
  const countOf = (...statuses: string[]) =>
    (statusCounts?.groups ?? [])
      .filter((group) => group.key !== null && statuses.includes(group.key))
      .reduce((sum, group) => sum + group.count, 0)
  const stats = {
    total: statusCounts?.total ?? data.total,
    succeeded: countOf('succeeded'),
    running: countOf('running', 'queued'),
    failed: countOf('failed'),
  }

  // Self-hosted runner device names for the per-row runtime chip — resolve self:<id> / self:ws:<id> to a
  // friendly label (bare pools self / self:ws carry no id, so they need no roster). Gated on the runtime
  // FACET rather than on the loaded rows: the facet lists every runtime present in the narrowed collection,
  // including the ones further down than this page reached, so "load older" cannot surface a runner whose
  // name we never fetched. Best-effort like the members join — a failed fetch falls back to the raw id.
  const runnerLabels: Record<string, string> = {}
  if (
    (data.facets.runtime ?? []).some(
      (option) => option.value.startsWith('self:') && option.value !== 'self:ws'
    )
  ) {
    try {
      const roster = runnersResponseSchema.parse(await controlPlane.listWorkspaceRunners(ctx))
      for (const r of roster.runners) runnerLabels[r.id] = r.label
    } catch {
      // roster fetch failed → the chip shows the raw runtime id
    }
  }

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

      {data.error !== undefined ? (
        <Callout tone="danger">{t('connectError', { error: data.error })}</Callout>
      ) : stats.total === 0 && data.total === 0 ? (
        <EmptyState title={t('emptyTitle')} hint={t('emptyHint')} />
      ) : (
        <ScorecardList
          workspace={workspace}
          initialData={data}
          stats={stats}
          authors={authors}
          runnerLabels={runnerLabels}
          scope={{ ...scope, filters: view.filters }}
          viewer={viewer}
        />
      )}
    </div>
  )
}
