import Link from 'next/link'
import { CalendarClock, FolderKanban } from 'lucide-react'
import { getTimeZone, getTranslations } from 'next-intl/server'

import { CreateProjectButton } from '@/features/manage-project'
import { initiativesSchema, type Initiative } from '@/entities/initiative'
import {
  isPastDue,
  PROJECT_STATUSES,
  projectsSchema,
  ProjectStatusBadge,
  type Project,
} from '@/entities/project'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// Projects — issues under one target date. The list stays lean by contract (rollups are derived per detail
// read), so a row shows the deadline and its status, not counts.
export default async function ProjectsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>
  searchParams: Promise<{ status?: string; initiative?: string; team?: string }>
}) {
  const { workspace } = await params
  const { status, initiative, team } = await searchParams
  const t = await getTranslations('projectsPage')
  const tracker = await getTranslations('tracker')
  const timeZone = await getTimeZone()
  const { principal, ctx } = await currentPrincipal()

  let projects: Project[] = []
  let error: string | undefined
  try {
    projects = projectsSchema.parse(
      await controlPlane.listProjects(ctx, {
        ...(status ? { status } : {}),
        ...(initiative ? { initiative } : {}),
        ...(team ? { team } : {}),
      })
    )
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  const initiatives: Initiative[] = await controlPlane
    .listInitiatives(ctx)
    .then((r) => initiativesSchema.parse(r))
    .catch(() => [])
  const initiativeName = new Map(initiatives.map((i) => [i.id, i.name]))
  const canWrite = can(principal?.roles ?? [], 'issues:write')

  function filterHref(nextStatus?: string): string {
    const q = new URLSearchParams()
    if (nextStatus) q.set('status', nextStatus)
    if (initiative) q.set('initiative', initiative)
    // 팀 스코프는 상태 칩을 눌러도 유지된다 — 팀 안에서 필터링하는 것이지 워크스페이스 전체로 빠져나오는 게 아니다.
    if (team) q.set('team', team)
    const qs = q.toString()
    return `/${workspace}/projects${qs ? `?${qs}` : ''}`
  }

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
            <CreateProjectButton
              workspace={workspace}
              initiatives={initiatives.map((i) => ({ id: i.id, name: i.name }))}
            />
          ) : null
        }
      />

      <div className="flex flex-wrap items-center gap-1.5">
        <Link href={filterHref()} className={chip(!status)}>
          {t('filterAll')}
        </Link>
        {PROJECT_STATUSES.map((s) => (
          <Link key={s} href={filterHref(s)} className={chip(status === s)}>
            {tracker(`projectStatus.${s}`)}
          </Link>
        ))}
      </div>

      {error ? (
        <Callout tone="danger">{t('loadError', { error })}</Callout>
      ) : projects.length === 0 ? (
        <EmptyState
          icon={<FolderKanban strokeWidth={1.75} />}
          title={t('emptyTitle')}
          hint={t('emptyHint')}
        />
      ) : (
        <div className="space-y-2">
          {projects.map((p) => {
            const overdue =
              p.status !== 'completed' &&
              p.status !== 'cancelled' &&
              isPastDue(p.targetDate, timeZone)
            return (
              <Link
                key={p.id}
                href={`/${workspace}/projects/${encodeURIComponent(p.id)}`}
                className="group flex items-center gap-3 rounded-lg border bg-card px-3.5 py-2.5 shadow-raise transition-colors hover:border-border-strong hover:bg-elevated"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-[510] text-foreground">{p.name}</p>
                  {p.initiativeId && (
                    <p className="mt-0.5 truncate text-[11.5px] text-muted-foreground">
                      {initiativeName.get(p.initiativeId) ?? p.initiativeId}
                    </p>
                  )}
                </div>
                {p.targetDate && (
                  <span
                    className={cn(
                      'hidden shrink-0 items-center gap-1 font-mono text-[11px] @md:inline-flex',
                      overdue ? 'text-destructive' : 'text-muted-foreground'
                    )}
                  >
                    <CalendarClock className="size-3.5" />
                    {p.targetDate}
                  </span>
                )}
                {overdue && <Badge tone="danger">{t('overdue')}</Badge>}
                <ProjectStatusBadge status={p.status} />
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
