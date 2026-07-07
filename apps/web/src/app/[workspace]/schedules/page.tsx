import Link from 'next/link'
import { getTranslations } from 'next-intl/server'

import { ScheduleList } from '@/features/manage-schedules'
import { membersSchema } from '@/entities/member'
import { schedulesSchema } from '@/entities/schedule'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { nextFires } from '@/shared/lib/cron'
import { buttonVariants } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

export default async function SchedulesPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { workspace } = await params
  const t = await getTranslations('schedulesPage')
  const rawView = (await searchParams).view
  const viewParam = Array.isArray(rawView) ? rawView[0] : rawView
  const initialView = viewParam === 'owner' || viewParam === 'calendar' ? viewParam : 'list'
  const { principal, ctx } = await currentPrincipal()
  const canWrite = can(principal?.roles, 'schedules:write')
  let error: string | undefined
  let schedules = schedulesSchema.parse([])
  try {
    schedules = schedulesSchema.parse(await controlPlane.listSchedules(ctx))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  // The owner label (members join) is supplementary — the list still shows even if it fails. (Same pattern as the scorecard list.)
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

  // Next fire time: if the control plane has nextFireTimes computed via Temporal, use those (authoritative),
  // otherwise (Temporal not deployed) approximate with cron. Fixing now → relative date labels are identical on server/client (hydration-safe).
  // A paused schedule doesn't fire, so an empty array.
  const now = new Date()
  const nowIso = now.toISOString()
  const fires: Record<string, string[]> = {}
  for (const s of schedules)
    fires[s.id] = !s.enabled
      ? []
      : s.nextFireTimes && s.nextFireTimes.length > 0
        ? s.nextFireTimes
        : nextFires(s.cron, s.timezone, now, { count: 8, horizonDays: 45 }).map((d) =>
            d.toISOString()
          )

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('title')}
        description={t('description', { count: schedules.length })}
        actions={
          canWrite ? (
            <Link href={`/${workspace}/schedules/new`} className={buttonVariants({ size: 'sm' })}>
              {t('create')}
            </Link>
          ) : null
        }
      />
      {error ? (
        <Callout tone="danger">{t('connectError', { error })}</Callout>
      ) : schedules.length === 0 ? (
        <EmptyState title={t('emptyTitle')} hint={t('emptyHint')} />
      ) : (
        <ScheduleList
          schedules={schedules}
          authors={authors}
          workspace={workspace}
          fires={fires}
          nowIso={nowIso}
          me={principal?.subject ?? ''}
          canWrite={canWrite}
          isAdmin={principal?.roles.includes('admin') ?? false}
          initialView={initialView}
        />
      )}
    </div>
  )
}
