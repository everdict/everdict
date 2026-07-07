import Link from 'next/link'
import { Boxes, ChevronRight } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import { EvalDashboard } from '@/widgets/eval-dashboard'
import { RunsTable } from '@/widgets/runs-table'
import { harnessesSchema } from '@/entities/harness'
import { runsSchema } from '@/entities/run'
import { scorecardsSchema } from '@/entities/scorecard'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'
import { SectionHeader } from '@/shared/ui/section-header'

export const dynamic = 'force-dynamic'

function ViewAll({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
    >
      {label}
      <ChevronRight className="size-3.5" />
    </Link>
  )
}

export default async function OverviewPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace } = await params
  const t = await getTranslations('overviewPage')
  const ctx = await authContext()
  let error: string | undefined
  let runs = runsSchema.parse([])
  let harnesses = harnessesSchema.parse([])
  let scorecards = scorecardsSchema.parse([])
  try {
    const [r, h, sc] = await Promise.all([
      controlPlane.listRuns(ctx),
      controlPlane.listHarnesses(ctx),
      controlPlane.listScorecards(ctx),
    ])
    runs = runsSchema.parse(r)
    harnesses = harnessesSchema.parse(h)
    scorecards = scorecardsSchema.parse(sc)
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  return (
    <div className="space-y-7">
      <PageHeader title={t('title')} description={t('description')} />

      {error ? (
        <Callout tone="danger" hint={t('connectErrorHint')}>
          {t('connectError', { error })}
        </Callout>
      ) : (
        <EvalDashboard scorecards={scorecards} workspace={workspace} />
      )}

      <section className="space-y-2.5">
        <SectionHeader
          title={t('recentRuns')}
          action={<ViewAll href={`/${workspace}/runs`} label={t('viewAll')} />}
        />
        <RunsTable runs={runs} workspace={workspace} limit={5} />
      </section>

      <section className="space-y-2.5">
        <SectionHeader
          title={t('harnesses')}
          action={<ViewAll href={`/${workspace}/harnesses`} label={t('viewAll')} />}
        />
        {harnesses.length === 0 ? (
          <EmptyState
            icon={<Boxes />}
            title={t('emptyHarnessesTitle')}
            hint={t('emptyHarnessesHint')}
          />
        ) : (
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            {harnesses.slice(0, 6).map((h) => (
              <Link
                key={h.id}
                href={`/${workspace}/harnesses`}
                className="group flex items-start gap-3 rounded-lg border bg-card p-3.5 shadow-raise transition-colors hover:border-border-strong hover:bg-elevated"
              >
                <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md bg-elevated text-muted-foreground ring-1 ring-inset ring-border group-hover:text-foreground">
                  <Boxes className="size-[18px]" strokeWidth={1.75} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-[560] text-foreground">
                    {h.id}
                  </span>
                  <span className="mt-1 flex flex-wrap gap-1">
                    {h.versions.slice(0, 4).map((v) => (
                      <span
                        key={v}
                        className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground ring-1 ring-inset ring-border"
                      >
                        {v}
                      </span>
                    ))}
                    {h.versions.length > 4 && (
                      <span className="px-1 py-0.5 text-[10.5px] text-faint">
                        +{h.versions.length - 4}
                      </span>
                    )}
                  </span>
                </span>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
