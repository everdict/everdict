import { Boxes } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import {
  DEFAULT_HARNESS_DISPLAY,
  HARNESS_FACETS,
  HARNESS_GROUPINGS,
  HARNESS_ORDERS,
  harnessesSchema,
} from '@/entities/harness'
import { membersSchema } from '@/entities/member'
import { scorecardsSchema } from '@/entities/scorecard'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { buildHarnessRelations } from '@/shared/lib/harness-relations'
import { loadListViewScope } from '@/shared/lib/load-list-view'
import { buttonVariants } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { Link } from '@/shared/ui/link'
import { PageHeader } from '@/shared/ui/page-header'

import { HarnessList } from './harness-list'

// The registered harness list — one address per workspace. The same list also lived under a team for a while (the ones that team owned), but
// that axis was removed: the owning team remains and decides "who may edit it", while there is ONE route to find things, and
// "only our team's" is one filter axis (team) on this list.
//
// What the server does ends at reading the collection once and handing it over — filtering, grouping and ordering all happen in the browser.
// These lists have no pagination so the whole collection is in hand, and there is no reason to re-render the route every time a filter changes
// (which is what "why does changing the grouping take so long" on the issue list actually was).
export async function HarnessListView({
  workspace,
  params,
}: {
  workspace: string
  params: Record<string, string | string[] | undefined>
}) {
  const { principal, ctx } = await currentPrincipal()
  const t = await getTranslations('harnessesPage')

  let error: string | undefined
  let harnesses = harnessesSchema.parse([])
  try {
    harnesses = harnessesSchema.parse(await controlPlane.listHarnesses(ctx))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  // Run benchmarks (derived from scorecards) + registrant (members join) are supplementary info — the list shows up even if it fails.
  const scorecards = await controlPlane
    .listScorecards(ctx)
    .then((r) => scorecardsSchema.parse(r))
    .catch(() => [])
  const members = await controlPlane
    .listMembers(ctx)
    .then((r) => membersSchema.parse(r))
    .catch(() => [])

  const relations = buildHarnessRelations(scorecards)
  const authors: Record<string, { name: string; avatarUrl?: string }> = {}
  for (const m of members)
    authors[m.subject] = {
      name: m.name ?? m.email?.split('@')[0] ?? m.subject,
      ...(m.avatarUrl ? { avatarUrl: m.avatarUrl } : {}),
    }

  const currentWorkspace = principal?.workspace ?? workspace
  // Only expose harnesses registered by this workspace — shared (first-party) harnesses are excluded from the list.
  const ownHarnesses = harnesses.filter((h) => h.owner === currentWorkspace)

  const scope = await loadListViewScope({
    basePath: `/${workspace}/harnesses`,
    viewKey: 'harnesses',
    facets: HARNESS_FACETS,
    vocabulary: {
      groupings: HARNESS_GROUPINGS,
      orders: HARNESS_ORDERS,
      fallback: DEFAULT_HARNESS_DISPLAY,
    },
    params,
  })

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <div className="flex items-center gap-3">
            {/* To the shape catalog — "what do we evaluate WITH" (here) and "what shapes exist" are different questions. */}
            <Link
              href={`/${workspace}/harness-templates`}
              className="text-[12px] font-[510] text-link transition-colors hover:text-foreground"
            >
              {t('shapesLink')}
            </Link>
            {can(principal?.roles, 'harnesses:register') ? (
              <Link href={`/${workspace}/harnesses/new`} className={buttonVariants({ size: 'sm' })}>
                {t('register')}
              </Link>
            ) : null}
          </div>
        }
      />
      {error ? (
        <Callout tone="danger">{t('connectError', { error })}</Callout>
      ) : ownHarnesses.length === 0 ? (
        <EmptyState icon={<Boxes />} title={t('emptyTitle')} hint={t('emptyHint')} />
      ) : (
        <HarnessList
          workspace={workspace}
          harnesses={ownHarnesses}
          relations={relations}
          authors={authors}
          scope={scope}
          canDelete={can(principal?.roles, 'harnesses:delete')}
        />
      )}
    </div>
  )
}
