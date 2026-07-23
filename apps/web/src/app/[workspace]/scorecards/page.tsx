import Link from 'next/link'
import { getTranslations } from 'next-intl/server'

import { ScorecardList } from '@/widgets/scorecard-list'
import { membersSchema } from '@/entities/member'
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
}: {
  params: Promise<{ workspace: string }>
}) {
  const { workspace } = await params
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

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          canRun ? (
            <Link
              href={`/${workspace}/scorecards/new`}
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
          viewer={viewer}
        />
      )}
    </div>
  )
}
