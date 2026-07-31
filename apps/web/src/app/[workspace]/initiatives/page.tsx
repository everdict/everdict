import Link from 'next/link'
import { CalendarClock, Rocket } from 'lucide-react'
import { getTimeZone, getTranslations } from 'next-intl/server'

import { CreateInitiativeButton } from '@/features/manage-initiative'
import {
  INITIATIVE_STATUSES,
  initiativesSchema,
  InitiativeStatusBadge,
  type Initiative,
} from '@/entities/initiative'
import { isPastDue } from '@/entities/project'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// Initiatives — the deployment umbrella over projects. The readiness verdict is a fan-out, so it lives on the
// detail; a row here is the umbrella and its deadline.
export default async function InitiativesPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>
  searchParams: Promise<{ status?: string }>
}) {
  const { workspace } = await params
  const { status } = await searchParams
  const t = await getTranslations('initiativesPage')
  const tracker = await getTranslations('tracker')
  const timeZone = await getTimeZone()
  const { principal, ctx } = await currentPrincipal()

  let initiatives: Initiative[] = []
  let error: string | undefined
  try {
    initiatives = initiativesSchema.parse(
      await controlPlane.listInitiatives(ctx, { ...(status ? { status } : {}) })
    )
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  const canWrite = can(principal?.roles ?? [], 'issues:write')

  const chip = (active: boolean) =>
    cn(
      'rounded-full border px-2.5 py-0.5 text-[12px] transition-colors',
      active
        ? 'border-primary/40 bg-primary/10 text-foreground'
        : 'border-border text-muted-foreground hover:text-foreground'
    )

  return (
    <div className="@container space-y-6">
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={canWrite ? <CreateInitiativeButton workspace={workspace} /> : null}
      />

      <div className="flex flex-wrap items-center gap-1.5">
        <Link href={`/${workspace}/initiatives`} className={chip(!status)}>
          {t('filterAll')}
        </Link>
        {INITIATIVE_STATUSES.map((s) => (
          <Link
            key={s}
            href={`/${workspace}/initiatives?status=${s}`}
            className={chip(status === s)}
          >
            {tracker(`initiativeStatus.${s}`)}
          </Link>
        ))}
      </div>

      {error ? (
        <Callout tone="danger">{t('loadError', { error })}</Callout>
      ) : initiatives.length === 0 ? (
        <EmptyState
          icon={<Rocket strokeWidth={1.75} />}
          title={t('emptyTitle')}
          hint={t('emptyHint')}
        />
      ) : (
        <div className="space-y-2">
          {initiatives.map((i) => {
            const overdue = i.status === 'active' && isPastDue(i.targetDate, timeZone)
            return (
              <Link
                key={i.id}
                href={`/${workspace}/initiatives/${encodeURIComponent(i.id)}`}
                className="group flex items-center gap-3 rounded-lg border bg-card px-3.5 py-2.5 shadow-raise transition-colors hover:border-border-strong hover:bg-elevated"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-[510] text-foreground">{i.name}</p>
                  {i.description && (
                    <p className="mt-0.5 truncate text-[11.5px] text-muted-foreground">
                      {i.description}
                    </p>
                  )}
                </div>
                {i.targetDate && (
                  <span
                    className={cn(
                      'hidden shrink-0 items-center gap-1 font-mono text-[11px] @md:inline-flex',
                      overdue ? 'text-destructive' : 'text-muted-foreground'
                    )}
                  >
                    <CalendarClock className="size-3.5" />
                    {i.targetDate}
                  </span>
                )}
                {overdue && <Badge tone="danger">{t('overdue')}</Badge>}
                <InitiativeStatusBadge status={i.status} />
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
