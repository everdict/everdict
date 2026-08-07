import { Suspense } from 'react'
import { getTranslations } from 'next-intl/server'

import { FlakePanel, ReliabilityView } from '@/widgets/reliability'
import { Link } from '@/shared/ui/link'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// Reliability — the workspace's trust dashboard (metrics commercialization W1): the platform's failure
// share separated from the product's (ops report), the release-gate audit, and the cross-batch flake
// index. WHICH window / WHICH dataset are URL filters (a pasted link opens the same view); every number is
// served — the web derives nothing.
const WINDOWS = [7, 30, 90] as const

export default async function ReliabilityPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>
  searchParams: Promise<{ days?: string; dataset?: string }>
}) {
  const { workspace } = await params
  const { days: rawDays, dataset } = await searchParams
  const t = await getTranslations('reliabilityPage')
  const days = WINDOWS.find((w) => String(w) === rawDays)
  const window =
    days === undefined
      ? undefined
      : { from: new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString() }

  const withQuery = (nextDays?: number) => {
    const q = new URLSearchParams()
    if (nextDays !== undefined) q.set('days', String(nextDays))
    if (dataset) q.set('dataset', dataset)
    const qs = q.toString()
    return qs ? `/${workspace}/reliability?${qs}` : `/${workspace}/reliability`
  }

  return (
    <div className="@container space-y-7">
      <PageHeader title={t('title')} description={t('description')} />

      <div className="flex gap-1.5 text-[12px]">
        <Link
          href={withQuery()}
          className={
            days === undefined
              ? 'rounded-md border border-[var(--color-link)] px-2 py-1 text-[var(--color-link)]'
              : 'rounded-md border px-2 py-1 text-muted-foreground hover:border-border-strong'
          }
        >
          {t('window.all')}
        </Link>
        {WINDOWS.map((w) => (
          <Link
            key={w}
            href={withQuery(w)}
            className={
              days === w
                ? 'rounded-md border border-[var(--color-link)] px-2 py-1 text-[var(--color-link)]'
                : 'rounded-md border px-2 py-1 text-muted-foreground hover:border-border-strong'
            }
          >
            {t('window.days', { days: w })}
          </Link>
        ))}
      </div>

      <Suspense>
        <ReliabilityView {...(window ? { window } : {})} />
      </Suspense>

      <Suspense>
        <FlakePanel workspace={workspace} {...(dataset ? { dataset } : {})} />
      </Suspense>
    </div>
  )
}
