import Link from 'next/link'
import { getTranslations } from 'next-intl/server'

import { ScorecardList } from '@/widgets/scorecard-list'
import { membersSchema } from '@/entities/member'
import { runnersResponseSchema } from '@/entities/runner'
import { scorecardsSchema } from '@/entities/scorecard'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { buttonVariants } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

export default async function ScorecardsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>
  searchParams: Promise<{ team?: string }>
}) {
  const { workspace } = await params
  // 팀 스코프 — 사이드바의 팀 하위 스코어카드가 이 파라미터로 들어온다.
  const { team } = await searchParams
  const { principal, ctx } = await currentPrincipal()
  const t = await getTranslations('scorecardsPage')
  let error: string | undefined
  let scorecards = scorecardsSchema.parse([])
  try {
    scorecards = scorecardsSchema.parse(
      await controlPlane.listScorecards(ctx, team ? { team } : undefined)
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

  const canRun = can(principal?.roles, 'scorecards:run')
  // Row-trash gating info for the list: an admin deletes any terminal batch, a member only their own.
  const viewer = {
    ...(principal?.subject !== undefined ? { subject: principal.subject } : {}),
    admin: can(principal?.roles, 'scorecards:delete'),
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
