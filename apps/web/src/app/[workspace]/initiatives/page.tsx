import { CalendarClock, Target } from 'lucide-react'
import { getTimeZone, getTranslations } from 'next-intl/server'

import { CreateInitiativeButton } from '@/features/manage-initiative'
import {
  INITIATIVE_STATUSES,
  initiativeHref,
  initiativesSchema,
  InitiativeStatusBadge,
  type InitiativeListItem,
} from '@/entities/initiative'
import { isPastDue } from '@/entities/project'
import { HealthBadge } from '@/entities/tracker-health'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { markdownPreview } from '@/shared/lib/markdown-preview'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { Link } from '@/shared/ui/link'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// Initiatives — the goals several projects work toward. One row answers what the goal is, by when, what the lead SAID (health), and
// **how far along it is**. The progress is a number the server sent down from ONE aggregate rather than a fan-out from the detail
// (it was absent from the list at first, which is what made the list a recitation of names).
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

  let initiatives: InitiativeListItem[] = []
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
        actions={
          canWrite ? (
            <CreateInitiativeButton
              workspace={workspace}
              timeZone={timeZone}
              initiatives={initiatives.map((i) => ({ id: i.id, name: i.name }))}
            />
          ) : null
        }
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
          icon={<Target strokeWidth={1.75} />}
          title={t('emptyTitle')}
          hint={t('emptyHint')}
          // An empty list is the screen someone starting out looks at longest — the route to creating one is offered right here (the same surface as the header button).
          action={
            canWrite ? (
              <CreateInitiativeButton
                workspace={workspace}
                timeZone={timeZone}
                initiatives={initiatives.map((i) => ({ id: i.id, name: i.name }))}
              />
            ) : null
          }
        />
      ) : (
        <div className="space-y-2">
          {initiatives.map((i) => {
            // A goal neither finished nor abandoned can still be overdue — being in the planning stage does not make you not late.
            const overdue =
              i.status !== 'completed' &&
              i.status !== 'cancelled' &&
              isPastDue(i.targetDate, timeZone)
            return (
              <Link
                key={i.id}
                href={initiativeHref(workspace, i.id)}
                className="group flex items-center gap-3 rounded-lg border bg-card px-3.5 py-2.5 shadow-raise transition-colors hover:border-border-strong hover:bg-elevated"
              >
                <div className="min-w-0 flex-1">
                  <p className="flex min-w-0 items-center gap-1.5 truncate text-[13px] font-[510] text-foreground">
                    {i.icon && <span aria-hidden>{i.icon}</span>}
                    <span className="truncate">{i.name}</span>
                  </p>
                  {i.description && (
                    // The description is markdown — only text with the syntax stripped goes into a one-line preview.
                    <p className="mt-0.5 truncate text-[11.5px] text-muted-foreground">
                      {markdownPreview(i.description)}
                    </p>
                  )}
                </div>
                {/* How far along — this is why goals are swept in a list. A goal with no work attached draws NO bar:
                    0% reads as "not started", when what it actually means is that there is nothing to count. */}
                {i.progress.total > 0 && (
                  <span className="hidden shrink-0 items-center gap-2 @md:flex">
                    <span
                      className="h-1.5 w-16 overflow-hidden rounded-full bg-muted/40"
                      role="img"
                      aria-label={t('progressDone', {
                        done: i.progress.total - i.progress.open,
                        total: i.progress.total,
                      })}
                    >
                      <span
                        className="block h-full rounded-full bg-[var(--color-success)]"
                        style={{
                          width: `${Math.round(((i.progress.total - i.progress.open) / i.progress.total) * 100)}%`,
                        }}
                      />
                    </span>
                    <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                      {i.progress.total - i.progress.open}/{i.progress.total}
                    </span>
                  </span>
                )}
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
                {i.health !== undefined && <HealthBadge health={i.health} />}
                <InitiativeStatusBadge status={i.status} />
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
