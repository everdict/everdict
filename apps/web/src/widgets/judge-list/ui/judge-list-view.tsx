import { Gavel } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import {
  DEFAULT_JUDGE_DISPLAY,
  JUDGE_FACETS,
  JUDGE_GROUPINGS,
  JUDGE_ORDERS,
  judgesSchema,
} from '@/entities/judge'
import { membersSchema } from '@/entities/member'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { loadListViewScope } from '@/shared/lib/load-list-view'
import { buttonVariants } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { Link } from '@/shared/ui/link'
import { PageHeader } from '@/shared/ui/page-header'

import { JudgeList } from './judge-list'

// Agent Judges (model | harness) — workspace-owned plus the shared defaults. The same rules as harnesses and datasets:
// one address per workspace, the owning team as one filter axis, and filtering and grouping happening in the browser.
export async function JudgeListView({
  workspace,
  params,
}: {
  workspace: string
  params: Record<string, string | string[] | undefined>
}) {
  const t = await getTranslations('judgesPage')
  const { principal, ctx } = await currentPrincipal()

  let error: string | undefined
  let judges = judgesSchema.parse([])
  try {
    judges = judgesSchema.parse(await controlPlane.listJudges(ctx))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  // The creator and team NAMES are a supporting read for the axes' name plates — on a failure only that axis quietly disappears.
  const members = await controlPlane
    .listMembers(ctx)
    .then((r) => membersSchema.parse(r))
    .catch(() => [])

  const authors: Record<string, { name: string; avatarUrl?: string }> = {}
  for (const m of members)
    authors[m.subject] = {
      name: m.name ?? m.email?.split('@')[0] ?? m.subject,
      ...(m.avatarUrl ? { avatarUrl: m.avatarUrl } : {}),
    }

  const currentWorkspace = principal?.workspace ?? workspace
  // Delete = admin only (the creator exception is server-side); the affordance shows only on workspace-owned judges
  // (_shared/first-party delete 404s at the control plane).
  const canDeleteJudges = can(principal?.roles, 'judges:delete')

  const scope = await loadListViewScope({
    basePath: `/${workspace}/judges`,
    viewKey: 'judges',
    facets: JUDGE_FACETS,
    vocabulary: {
      groupings: JUDGE_GROUPINGS,
      orders: JUDGE_ORDERS,
      fallback: DEFAULT_JUDGE_DISPLAY,
    },
    params,
  })

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          can(principal?.roles, 'judges:write') ? (
            <Link href={`/${workspace}/judges/new`} className={buttonVariants({ size: 'sm' })}>
              {t('register')}
            </Link>
          ) : null
        }
      />
      {error ? (
        <Callout tone="danger">{t('connectError', { error })}</Callout>
      ) : judges.length === 0 ? (
        <EmptyState
          icon={<Gavel strokeWidth={1.75} />}
          title={t('emptyTitle')}
          hint={t('emptyHint')}
        />
      ) : (
        <JudgeList
          workspace={workspace}
          judges={judges}
          currentWorkspace={currentWorkspace}
          authors={authors}
          scope={scope}
          canDelete={canDeleteJudges}
        />
      )}
    </div>
  )
}
