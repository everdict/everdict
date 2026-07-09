import Link from 'next/link'
import { ListChecks } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import { rubricSpecSchema, rubricsSchema, type RubricSpec } from '@/entities/rubric'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { sortSemverDesc } from '@/shared/lib/semver'
import { Badge } from '@/shared/ui/badge'
import { buttonVariants } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// Rubrics — versioned judging criteria (owned + _shared). Rows carry the latest version's criteria count + tags,
// so each row also fetches its latest spec (soft-fail: the row still renders with id/version only).
export default async function RubricsPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace } = await params
  const t = await getTranslations('rubricsPage')
  const { principal, ctx } = await currentPrincipal()

  let error: string | undefined
  let rubrics = rubricsSchema.parse([])
  try {
    rubrics = rubricsSchema.parse(await controlPlane.listRubrics(ctx))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  const rows = await Promise.all(
    rubrics.map(async (r) => {
      const latest = sortSemverDesc(r.versions)[0] ?? r.versions[0] ?? 'latest'
      let spec: RubricSpec | undefined
      try {
        spec = rubricSpecSchema.parse(await controlPlane.getRubric(ctx, r.id, latest))
      } catch {
        spec = undefined
      }
      return { summary: r, latest, spec }
    })
  )

  const currentWorkspace = principal?.workspace ?? workspace

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          can(principal?.roles, 'judges:write') ? (
            <Link href={`/${workspace}/rubrics/new`} className={buttonVariants({ size: 'sm' })}>
              {t('register')}
            </Link>
          ) : null
        }
      />
      {error ? (
        <Callout tone="danger">{t('connectError', { error })}</Callout>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<ListChecks strokeWidth={1.75} />}
          title={t('emptyTitle')}
          hint={t('emptyHint')}
        />
      ) : (
        <div className="space-y-2">
          {rows.map(({ summary, latest, spec }) => (
            <Link
              key={summary.id}
              href={`/${workspace}/rubrics/${encodeURIComponent(summary.id)}`}
              className="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-3.5 shadow-raise transition-colors hover:border-border-strong hover:bg-elevated"
            >
              <span className="grid size-8 shrink-0 place-items-center rounded-md bg-elevated text-muted-foreground ring-1 ring-inset ring-border">
                <ListChecks className="size-[18px]" strokeWidth={1.75} />
              </span>
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="truncate font-mono text-[13px] font-[560] text-foreground">
                    {summary.id}
                  </span>
                  <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[11px] text-secondary-foreground ring-1 ring-inset ring-border">
                    {latest}
                  </code>
                  {spec && (spec.criteria?.length ?? 0) > 0 && (
                    <code className="rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                      {t('criteriaCount', { count: spec.criteria?.length ?? 0 })}
                    </code>
                  )}
                </div>
                {spec && (spec.tags?.length ?? 0) > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {spec.tags?.map((tag) => (
                      <span
                        key={tag}
                        className="rounded border border-border bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <Badge tone={summary.owner === currentWorkspace ? 'success' : 'neutral'}>
                {summary.owner === currentWorkspace ? t('workspaceBadge') : t('sharedBadge')}
              </Badge>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
