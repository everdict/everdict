import type { ReactNode } from 'react'
import Link from 'next/link'
import { ChevronRight, Target } from 'lucide-react'
import { getTimeZone, getTranslations } from 'next-intl/server'

import { InitiativeActions, InitiativeStatusControl } from '@/features/manage-initiative'
import { initiativeHref } from '@/entities/initiative'
import { memberDirectoryOf, memberNameOf } from '@/entities/member'
import { isPastDue } from '@/entities/project'
import { HealthBadge } from '@/entities/tracker-health'
import { can } from '@/shared/auth/can'
import { fmtDateTime, fmtDateTimeFull } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { Callout } from '@/shared/ui/callout'
import { CopyLinkButton } from '@/shared/ui/copy-link-button'
import { PageHeader } from '@/shared/ui/page-header'
import { PropertyList, PropertyRow } from '@/shared/ui/property-list'
import { InfoTip } from '@/shared/ui/tooltip'

import { InitiativeTabs } from './initiative-tabs'
import { loadInitiative } from './load-initiative'

export const dynamic = 'force-dynamic'

// 하나의 목표(Initiative) — "무엇을 이루려 하는가, 지금 어디쯤인가". 배포 단위가 아니다: 완료가 게이트인
// 이유는 열린 일이 남은 목표가 아직 이뤄지지 않았기 때문이지, 무언가를 내보내기 때문이 아니다.
//
// 골격은 형제 화면인 프로젝트 상세의 것이고, 그 위에 리니어의 탭을 얹었다. ① 브레드크럼(목표 목록 → 상위
// 목표)과 이 목표에 할 수 있는 일(링크 복사·⋯), ② 이름은 크게 혼자, ③ 탭(개요·프로젝트·업데이트),
// ④ 속성과 진척은 오른쪽 한 열 — 탭을 옮겨도 이 셋은 그대로 남는다. 그래서 "이 목표가 무엇인지"를 잃지
// 않은 채 안을 돌아다닐 수 있다.
export default async function InitiativeDetailLayout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ workspace: string; id: string }>
}) {
  const { workspace, id } = await params
  const t = await getTranslations('initiativesPage')
  const timeZone = await getTimeZone()
  const { initiative, error, roles, initiatives, members } = await loadInitiative(id)

  if (!initiative) {
    return (
      <div className="space-y-5">
        <Link
          href={`/${workspace}/initiatives`}
          className="text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
        >
          {t('backToList')}
        </Link>
        <PageHeader title={t('detailFallbackTitle')} />
        <Callout tone="danger">{t('loadError', { error: error ?? '' })}</Callout>
      </div>
    )
  }

  const current = initiative
  const { readiness } = current
  const canWrite = can(roles, 'issues:write')
  const parent = current.parentId ? initiatives.find((i) => i.id === current.parentId) : undefined
  // 계획 단계라고 안 늦는 건 아니다 — 끝났거나 접힌 목표만 기한 판정에서 빠진다.
  const overdue =
    current.status !== 'completed' &&
    current.status !== 'cancelled' &&
    isPastDue(current.targetDate, timeZone)
  const actors = memberDirectoryOf(members)
  // 이룬 만큼 — 취소된 일은 분모에서 빠진다(하지 않기로 한 일은 미룬 일이 아니다).
  const scope = readiness.totalIssues
  const done = Math.max(scope - readiness.openIssues, 0)
  const percent = scope === 0 ? 0 : Math.round((done / scope) * 100)

  return (
    <div className="@container">
      {/* ① 이 목표가 어디에 걸려 있는지, 그리고 이 목표에 할 수 있는 일. */}
      <div className="flex items-center gap-1 border-b border-border pb-2.5">
        <nav
          aria-label={t('breadcrumbLabel')}
          className="flex min-w-0 items-center gap-1 text-[12.5px]"
        >
          <Link
            href={`/${workspace}/initiatives`}
            className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
          >
            {t('title')}
          </Link>
          {parent && (
            <>
              <ChevronRight className="size-3 shrink-0 text-faint" />
              <Link
                href={initiativeHref(workspace, parent.id)}
                className="truncate text-muted-foreground transition-colors hover:text-foreground"
              >
                {parent.name}
              </Link>
            </>
          )}
        </nav>
        <CopyLinkButton label={t('copyLink')} message={t('linkCopied')} className="ml-0.5" />
        {canWrite && (
          <InitiativeActions
            workspace={workspace}
            initiative={current}
            initiatives={initiatives.map((i) => ({ id: i.id, name: i.name }))}
            members={members.map((m) => ({
              subject: m.subject,
              name: memberNameOf(actors, m.subject),
            }))}
          />
        )}
      </div>

      {/* ② 이름은 사람이 지은 자유 텍스트다 — 자르지 않고 줄바꿈한다. */}
      <h1 className="flex items-start gap-2 break-words pt-5 text-[22px] font-[560] leading-[1.3] tracking-[-0.01em] text-foreground">
        {/* 아이콘은 이름의 일부가 아니라 표식이다 — 읽히는 건 이름이므로 스크린리더에서는 감춘다. */}
        {current.icon && <span aria-hidden>{current.icon}</span>}
        <span className="min-w-0">{current.name}</span>
      </h1>

      {/* ③ 같은 목표의 세 가지 물음 — 무엇이고 어디쯤인가 / 그 아래 일들은 어느 단계인가 / 책임자는 뭐라 했나. */}
      <div className="pt-4">
        <InitiativeTabs workspace={workspace} id={current.id} />
      </div>

      <div className="grid gap-x-8 gap-y-6 pt-5 @3xl:grid-cols-[minmax(0,1fr)_17rem]">
        {/* ④ 속성과 진척. 좁을 때는 탭 바로 아래로 접히므로 아래쪽 경계선으로 본문과 갈라 준다. */}
        <aside className="min-w-0 space-y-3.5 border-b border-border pb-6 @3xl:col-start-2 @3xl:row-start-1 @3xl:self-start @3xl:border-b-0 @3xl:pb-0">
          <PropertyList>
            <PropertyRow label={t('fieldStatus')}>
              <InitiativeStatusControl
                id={current.id}
                status={current.status}
                canWrite={canWrite}
              />
            </PropertyRow>
            {current.health !== undefined && (
              <PropertyRow label={t('fieldHealth')}>
                <HealthBadge health={current.health} />
              </PropertyRow>
            )}
            {current.lead !== undefined && (
              <PropertyRow label={t('fieldLead')}>
                <span className="truncate">{memberNameOf(actors, current.lead)}</span>
              </PropertyRow>
            )}
            {current.memberIds.length > 0 && (
              <PropertyRow label={t('fieldMembers')}>
                <span className="inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  {current.memberIds.map((subject) => (
                    <span key={subject} className="truncate">
                      {memberNameOf(actors, subject)}
                    </span>
                  ))}
                </span>
              </PropertyRow>
            )}
            {parent && (
              <PropertyRow label={t('nestingParent')}>
                <Link
                  href={initiativeHref(workspace, parent.id)}
                  className="inline-flex min-w-0 items-center gap-1.5 transition-colors hover:text-foreground"
                >
                  <Target className="size-3.5 shrink-0 text-faint" />
                  <span className="truncate">{parent.name}</span>
                </Link>
              </PropertyRow>
            )}
            {current.targetDate && (
              <PropertyRow label={t('metaTargetDate')}>
                <span
                  className={cn(
                    'inline-flex flex-wrap items-center gap-1.5',
                    overdue && 'text-destructive'
                  )}
                >
                  <time dateTime={current.targetDate}>{current.targetDate}</time>
                  {overdue && <Badge tone="danger">{t('overdue')}</Badge>}
                </span>
              </PropertyRow>
            )}
            {current.completedAt && (
              <PropertyRow label={t('metaCompleted')}>
                <time
                  dateTime={current.completedAt}
                  title={fmtDateTimeFull(current.completedAt, { timeZone })}
                >
                  {fmtDateTime(current.completedAt, timeZone)}
                </time>
              </PropertyRow>
            )}
            <PropertyRow label={t('metaCreated')}>
              <time
                dateTime={current.createdAt}
                title={fmtDateTimeFull(current.createdAt, { timeZone })}
              >
                {fmtDateTime(current.createdAt, timeZone)}
              </time>
            </PropertyRow>
          </PropertyList>

          {/* 진척은 속성이 아니라 판정이라 구분선 아래로 내린다. 한 줄 막대가 "얼마나 왔나"에 답하고,
              그 아래 숫자가 무엇이 남았는지를 말한다. */}
          <div className="space-y-2.5 border-t border-border pt-3.5">
            <div className="flex items-center justify-between gap-2">
              <p className="inline-flex items-center gap-1 text-[11px] font-[510] uppercase tracking-wide text-faint">
                {t('progressTitle')}
                <InfoTip content={t('progressTip')} />
              </p>
              <span className="text-[12px] tabular-nums text-muted-foreground">{percent}%</span>
            </div>
            <div
              className="h-2 w-full overflow-hidden rounded-full bg-muted/40"
              role="img"
              aria-label={t('progressDone', { done, total: scope })}
            >
              <div
                className="h-full rounded-full bg-[var(--color-success)]"
                style={{ width: `${percent}%` }}
              />
            </div>
            <PropertyList>
              <PropertyRow label={t('progressOpen')}>
                <span className={cn('tabular-nums', readiness.openIssues > 0 && 'text-foreground')}>
                  {readiness.openIssues}
                </span>
              </PropertyRow>
              <PropertyRow label={t('progressTotal')}>
                <span className="tabular-nums">{readiness.totalIssues}</span>
              </PropertyRow>
              <PropertyRow label={t('progressProjects')}>
                <span className="tabular-nums">{readiness.projects.length}</span>
              </PropertyRow>
            </PropertyList>
          </div>
        </aside>

        {/* 탭이 그리는 본문. */}
        <div className="min-w-0 @3xl:col-start-1 @3xl:row-start-1">{children}</div>
      </div>
    </div>
  )
}
