import Link from 'next/link'
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
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// Initiatives — 여러 프로젝트가 함께 향하는 목표들. 한 줄이 그 목표가 무엇이고, 언제까지이고, 책임자가
// 뭐라고 말했고(health), **얼마나 왔는지**까지 답한다. 진척은 상세의 팬아웃이 아니라 서버가 집계 한 번으로
// 내려 준 숫자다(초기에는 목록에 없었고, 그래서 목록이 이름의 나열이었다).
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
          // 빈 목록은 시작하는 사람이 가장 오래 보는 화면이다 — 만드는 길을 여기서 바로 내준다(헤더 버튼과 같은 표면).
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
            const overdue = i.status === 'active' && isPastDue(i.targetDate, timeZone)
            return (
              <Link
                key={i.id}
                href={initiativeHref(workspace, i.id)}
                className="group flex items-center gap-3 rounded-lg border bg-card px-3.5 py-2.5 shadow-raise transition-colors hover:border-border-strong hover:bg-elevated"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-[510] text-foreground">{i.name}</p>
                  {i.description && (
                    // 설명은 마크다운이다 — 한 줄 미리보기에는 문법을 벗겨 낸 텍스트만 넣는다.
                    <p className="mt-0.5 truncate text-[11.5px] text-muted-foreground">
                      {markdownPreview(i.description)}
                    </p>
                  )}
                </div>
                {/* 얼마나 왔나 — 목록에서 목표를 훑는 이유가 이것이다. 일이 하나도 걸려 있지 않은 목표는
                    막대를 그리지 않는다: 0%는 "시작 안 함"으로 읽히지만, 실제로는 셀 것이 없다는 뜻이다. */}
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
