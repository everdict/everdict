import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import { CommentsSection } from '@/features/discuss'
import { CompleteCycleButton } from '@/features/manage-cycle'
import {
  cycleDetailSchema,
  cycleLabel,
  cyclesSchema,
  CycleStateBadge,
  type Cycle,
  type CycleDetail,
} from '@/entities/cycle'
import {
  isOpenIssueStatus,
  issueHref,
  issuePageSchema,
  IssuePriorityIcon,
  IssueStatusIcon,
  type IssueSummary,
} from '@/entities/issue'
import { memberDirectoryOf, membersSchema } from '@/entities/member'
import { teamSectionHref, teamWithSummarySchema } from '@/entities/team'
import { TrackerHistory } from '@/entities/tracker-history'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Callout } from '@/shared/ui/callout'
import { DistributionBar } from '@/shared/ui/distribution-bar'
import { PageHeader } from '@/shared/ui/page-header'
import { PropertyList, PropertyRow } from '@/shared/ui/property-list'
import { SectionHeader } from '@/shared/ui/section-header'
import { StatCard } from '@/shared/ui/stat-card'
import { InfoTip } from '@/shared/ui/tooltip'

export const dynamic = 'force-dynamic'

// 한 이터레이션 — "이번 주기는 어떻게 가고 있나". 진행도는 저장된 값이 아니라 이 읽기에서 세어진 것이라
// 언제나 최신이고, 개수(이슈)와 포인트(추정치)를 나눠 보여 준다: 추정 없는 이슈를 1로 세면 번다운이 부푼다.
export default async function CycleDetailPage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>
}) {
  const { workspace, id } = await params
  const t = await getTranslations('cyclesPage')
  const tracker = await getTranslations('tracker')
  const { principal, ctx } = await currentPrincipal()

  let cycle: CycleDetail | undefined
  let error: string | undefined
  try {
    cycle = cycleDetailSchema.parse(await controlPlane.getCycle(ctx, id))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  if (!cycle) {
    return (
      <div className="space-y-5">
        <Link
          href={`/${workspace}/teams`}
          className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
          {t('backToList')}
        </Link>
        <PageHeader title={t('detailFallbackTitle')} />
        <Callout tone="danger">{t('loadError', { error: error ?? '' })}</Callout>
      </div>
    )
  }
  const current = cycle

  const [issues, siblings, members, team] = await Promise.all([
    controlPlane
      .listIssues(ctx, { cycle: id, limit: 200 })
      .then((r) => issuePageSchema.parse(r).items)
      .catch((): IssueSummary[] => []),
    // 이월 대상 후보 — 같은 팀의 열린 사이클, 자기 자신은 제외.
    controlPlane
      .listCycles(ctx, { team: current.teamId, open: true })
      .then((r) => cyclesSchema.parse(r))
      .catch((): Cycle[] => []),
    controlPlane
      .listMembers(ctx)
      .then((r) => membersSchema.parse(r))
      .catch(() => []),
    // 이 사이클을 소유한 팀 — 목록으로 돌아가는 링크가 그 팀의 주소(`…/teams/ENG/cycles`)여야 하므로
    // 키가 필요하다. 실패하면 팀 목록 링크를 접는다(뒤로 가기가 여전히 그 자리를 대신한다).
    controlPlane
      .getTeam(ctx, current.teamId)
      .then((r) => teamWithSummarySchema.parse(r))
      .catch((): undefined => undefined),
  ])

  const canWrite = can(principal?.roles ?? [], 'issues:write')
  const actors = memberDirectoryOf(members)
  const { progress } = current
  const carryTargets = siblings
    .filter((c) => c.id !== current.id)
    .map((c) => ({ id: c.id, label: cycleLabel(c) }))

  return (
    <div className="@container space-y-7">
      <div className="space-y-3">
        <Link
          href={team ? teamSectionHref(workspace, team.key, 'cycles') : `/${workspace}/teams`}
          className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
          {t('backToList')}
        </Link>
        <PageHeader
          title={cycleLabel(current)}
          description={current.description}
          actions={
            <div className="flex items-center gap-2">
              <CycleStateBadge state={current.state} />
              {canWrite && current.state !== 'completed' && (
                <CompleteCycleButton
                  id={current.id}
                  openCycles={carryTargets}
                  unfinished={progress.open}
                />
              )}
            </div>
          }
        />
      </div>

      {/* 진행도 — 개수와 포인트를 나란히. 포인트는 추정치가 있는 이슈만의 합이므로 `estimated` 를 함께 낸다. */}
      <div className="grid gap-3 @md:grid-cols-2 @2xl:grid-cols-4">
        <StatCard
          label={t('statOpen')}
          value={progress.open}
          tone={progress.open > 0 ? 'danger' : 'success'}
        />
        <StatCard label={t('statDone')} value={progress.done} />
        <StatCard label={t('statScope')} value={`${progress.completedScope}/${progress.scope}`} />
        <StatCard label={t('statEstimated')} value={`${progress.estimated}/${progress.total}`} />
      </div>
      {progress.total > 0 && (
        <DistributionBar
          segments={[
            { label: t('statDone'), count: progress.done },
            { label: t('statOpen'), count: progress.open },
          ]}
        />
      )}

      <PropertyList>
        <PropertyRow label={t('fieldWindow')}>
          <span className="font-mono">
            {current.startsAt} → {current.endsAt}
          </span>
        </PropertyRow>
        {current.completedAt !== undefined && (
          <PropertyRow label={t('fieldCompletedAt')}>
            <time dateTime={current.completedAt}>{current.completedAt.slice(0, 10)}</time>
          </PropertyRow>
        )}
      </PropertyList>

      {issues.length > 0 && (
        <section className="space-y-3">
          <SectionHeader
            title={t('issuesTitle', { count: issues.length })}
            action={<InfoTip content={t('issuesTip')} />}
          />
          <div className="space-y-1.5">
            {issues.map((issue) => (
              <Link
                key={issue.id}
                href={issueHref(workspace, issue.identifier)}
                className="flex items-center gap-2.5 rounded-lg border bg-card px-3 py-2 shadow-raise transition-colors hover:border-border-strong hover:bg-elevated"
              >
                <IssueStatusIcon status={issue.status} />
                <IssuePriorityIcon priority={issue.priority} />
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                  {issue.identifier}
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                  {issue.title}
                </span>
                {issue.estimate !== undefined && (
                  <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                    {issue.estimate}
                  </span>
                )}
                {!isOpenIssueStatus(issue.status) && (
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {tracker(`issueStatus.${issue.status}`)}
                  </span>
                )}
              </Link>
            ))}
          </div>
        </section>
      )}

      <section className="space-y-3">
        <SectionHeader title={t('historyTitle')} />
        <TrackerHistory
          kind="cycle"
          subject={cycleLabel(current)}
          entries={current.history}
          actors={actors}
          workspace={workspace}
        />
      </section>

      <CommentsSection workspace={workspace} resourceType="cycle" resourceId={current.id} />
    </div>
  )
}
