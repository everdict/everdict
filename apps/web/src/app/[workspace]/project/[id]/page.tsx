import { ChevronLeft, ChevronRight, Flag } from 'lucide-react'
import { getTimeZone, getTranslations } from 'next-intl/server'

import { CommentsSection } from '@/features/discuss'
import {
  ProjectActions,
  ProjectInitiativeControl,
  ProjectStatusControl,
  ProjectUpdatePanel,
} from '@/features/manage-project'
import { initiativeHref, initiativesSchema, type Initiative } from '@/entities/initiative'
import {
  ISSUE_STATUSES,
  issueHref,
  issuePageSchema,
  IssueStatusIcon,
  type IssueSummary,
} from '@/entities/issue'
import { memberDirectoryOf, memberNameOf, membersSchema } from '@/entities/member'
import {
  isPastDue,
  projectDetailSchema,
  projectUpdatesSchema,
  type ProjectDetail,
  type ProjectUpdate,
} from '@/entities/project'
import {
  teamHref,
  TeamKeyBadge,
  teamsWithSummarySchema,
  type TeamWithSummary,
} from '@/entities/team'
import { HealthBadge } from '@/entities/tracker-health'
import { TrackerHistory } from '@/entities/tracker-history'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { fmtDateTime, fmtDateTimeFull } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { Callout } from '@/shared/ui/callout'
import { CopyLinkButton } from '@/shared/ui/copy-link-button'
import { DistributionBar } from '@/shared/ui/distribution-bar'
import { Link } from '@/shared/ui/link'
import { Markdown } from '@/shared/ui/markdown'
import { PageHeader } from '@/shared/ui/page-header'
import { PropertyList, PropertyRow } from '@/shared/ui/property-list'
import { SectionHeader } from '@/shared/ui/section-header'
import { InfoTip } from '@/shared/ui/tooltip'

export const dynamic = 'force-dynamic'

// 상태별 보드에 그릴 이슈 상한. 프로젝트의 진짜 총계는 서버가 파생하는 rollup 이 답하므로, 보드는
// 최근 활동순 한 장이면 된다 — 목록 전체를 끌어와야 하는 화면이 아니다.
const PROJECT_ISSUE_ROWS = 200

function BackLink({ workspace, label }: { workspace: string; label: string }) {
  return (
    <Link
      href={`/${workspace}/projects`}
      className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
    >
      <ChevronLeft className="size-3.5" />
      {label}
    </Link>
  )
}

// One project — "did we finish the evaluation in time". The rollup is derived on this read (never stored), so
// the counts are always live; `evaluated` is the stricter claim than `done`: closed WITH a scorecard.
//
// 레이아웃은 형제 화면인 이슈 상세(app/[workspace]/issues/[id])의 것을 그대로 쓴다 — Linear 프로젝트 뷰와 같은
// 골격이다. ① 상단 브레드크럼(프로젝트 → 이니셔티브)이 "이 프로젝트가 어느 목표에 매달려 있는지"에 답하고
// 그 옆에 이 프로젝트에 대한 작업(링크 복사·⋯)이 붙는다. ② 이름은 크게 혼자 선다. ③ 본문(설명·이슈·이력·논의)은
// 왼쪽 열, ④ 속성과 진행도는 전부 오른쪽 한 열. 종전 레이아웃이 낭비하던 자리가 여기서 사라진다: 메타 한 줄을
// 담던 전폭 카드와, 한 자리 숫자 넷을 1100px 에 늘어놓던 StatCard 그리드가 모두 오른쪽 속성 열로 접힌다.
export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>
}) {
  const { workspace, id } = await params
  const t = await getTranslations('projectsPage')
  const tracker = await getTranslations('tracker')
  const timeZone = await getTimeZone()
  const { principal, ctx } = await currentPrincipal()

  let project: ProjectDetail | undefined
  let error: string | undefined
  try {
    project = projectDetailSchema.parse(await controlPlane.getProject(ctx, id))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  if (!project) {
    return (
      <div className="space-y-5">
        <BackLink workspace={workspace} label={t('backToList')} />
        <PageHeader title={t('detailFallbackTitle')} />
        <Callout tone="danger">{t('loadError', { error: error ?? '' })}</Callout>
      </div>
    )
  }
  const current = project

  // Supplementary reads — the detail still renders if any of them fails, so they run together and a failure
  // degrades only its own slot.
  const [issues, initiatives, members, teams, updates] = await Promise.all([
    controlPlane
      // 프로젝트 상세의 상태별 보드 — 한 프로젝트의 이슈는 한 장에 들어가는 규모이고, 롤업 숫자는 서버가
      // 따로 파생한다(rollup). 여기서 필요한 건 그릴 행뿐이다.
      .listIssues(ctx, { project: [id], limit: PROJECT_ISSUE_ROWS })
      .then((r) => issuePageSchema.parse(r).items)
      .catch((): IssueSummary[] => []),
    controlPlane
      .listInitiatives(ctx)
      .then((r) => initiativesSchema.parse(r))
      .catch((): Initiative[] => []),
    controlPlane
      .listMembers(ctx)
      .then((r) => membersSchema.parse(r))
      .catch(() => []),
    controlPlane
      .listTeams(ctx)
      .then((r) => teamsWithSummarySchema.parse(r))
      .catch((): TeamWithSummary[] => []),
    // 올라온 업데이트 — health 색이 바뀐 이유가 여기 있다.
    controlPlane
      .listProjectUpdates(ctx, id)
      .then((r) => projectUpdatesSchema.parse(r))
      .catch((): ProjectUpdate[] => []),
  ])

  const canWrite = can(principal?.roles ?? [], 'issues:write')
  // 프로젝트는 여러 우산 아래 놓일 수 있다. 브레드크럼은 첫 번째만 이고 가고(경로는 하나여야 한다), 나머지는
  // 오른쪽 속성 열이 전부 보여 준다.
  const projectInitiatives = current.initiativeIds
    .map((initiativeId) => initiatives.find((i) => i.id === initiativeId))
    .filter((i): i is Initiative => i !== undefined)
  const initiative = projectInitiatives[0]
  const projectTeams = current.teamIds
    .map((teamId) => teams.find((x) => x.id === teamId))
    .filter((x): x is TeamWithSummary => x !== undefined)
  const overdue =
    current.status !== 'completed' &&
    current.status !== 'cancelled' &&
    isPastDue(current.targetDate, timeZone)
  const actors = memberDirectoryOf(members)

  const segments = ISSUE_STATUSES.map((status) => ({
    label: tracker(`issueStatus.${status}`),
    count: current.rollup.byStatus[status] ?? 0,
  })).filter((s) => s.count > 0)

  const grouped = ISSUE_STATUSES.map((status) => ({
    status,
    items: issues.filter((issue) => issue.status === status),
  })).filter((g) => g.items.length > 0)

  return (
    <div className="@container">
      {/* ① 이 프로젝트가 어디에 걸려 있는지, 그리고 이 프로젝트에 할 수 있는 일. */}
      <div className="flex items-center gap-1 border-b border-border pb-2.5">
        <nav
          aria-label={t('breadcrumbLabel')}
          className="flex min-w-0 items-center gap-1 text-[12.5px]"
        >
          <Link
            href={`/${workspace}/projects`}
            className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
          >
            {t('title')}
          </Link>
          {initiative && (
            <>
              <ChevronRight className="size-3 shrink-0 text-faint" />
              <Link
                href={initiativeHref(workspace, initiative.id)}
                className="truncate text-muted-foreground transition-colors hover:text-foreground"
              >
                {initiative.name}
              </Link>
            </>
          )}
        </nav>
        <CopyLinkButton label={t('copyLink')} message={t('linkCopied')} className="ml-0.5" />
        {canWrite && (
          <ProjectActions
            workspace={workspace}
            project={current}
            initiatives={initiatives.map((i) => ({ id: i.id, name: i.name }))}
            teams={teams.map((x) => ({ id: x.id, key: x.key, name: x.name }))}
          />
        )}
      </div>

      {/* ② 이름은 사람이 지은 자유 텍스트다 — 자르지 않고 줄바꿈한다. */}
      <h1 className="break-words pt-5 text-[22px] font-[560] leading-[1.3] tracking-[-0.01em] text-foreground">
        {current.name}
      </h1>

      <div className="grid gap-x-8 gap-y-6 pt-5 @3xl:grid-cols-[minmax(0,1fr)_17rem]">
        {/* ④ 속성과 진행도. 좁을 때는 이름 바로 아래로 접히므로 아래쪽 경계선으로 본문과 갈라 준다. */}
        <aside className="min-w-0 space-y-3.5 border-b border-border pb-6 @3xl:col-start-2 @3xl:row-start-1 @3xl:self-start @3xl:border-b-0 @3xl:pb-0">
          <PropertyList>
            <PropertyRow label={t('fieldStatus')}>
              <ProjectStatusControl id={current.id} status={current.status} canWrite={canWrite} />
            </PropertyRow>
            {/* 목표는 비어 있어도 줄을 남긴다 — 쓸 수 있는 사람에게는 이 줄이 배정하는 유일한 자리다.
                읽기만 하는 사람에게는 컨트롤이 null 을 돌려주므로 빈 줄 숨김 관습이 그대로 지켜진다. */}
            {(canWrite || projectInitiatives.length > 0) && (
              <PropertyRow label={t('fieldInitiative')}>
                <ProjectInitiativeControl
                  workspace={workspace}
                  id={current.id}
                  initiativeIds={current.initiativeIds}
                  initiatives={initiatives.map((i) => ({ id: i.id, name: i.name }))}
                  canWrite={canWrite}
                />
              </PropertyRow>
            )}
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
            {projectTeams.length > 0 && (
              <PropertyRow label={t('fieldTeams')}>
                {/* A team key is 2–6 characters, so the chip's width differs per team — flowing them wrapped
                    each name to its own ragged start once several teams stack. Sharing the key column through
                    subgrid sizes it to the widest key, so the rows keep the same column rhythm as the goal row
                    right above (whose icon is fixed-width) no matter how many teams there are. */}
                <span className="grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] gap-y-1">
                  {projectTeams.map((row) => (
                    <Link
                      key={row.id}
                      href={teamHref(workspace, row.key)}
                      className="col-span-2 grid grid-cols-subgrid items-center gap-x-2 transition-colors hover:text-foreground"
                    >
                      <TeamKeyBadge teamKey={row.key} />
                      <span className="truncate">{row.name}</span>
                    </Link>
                  ))}
                </span>
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

          {/* 진행도는 속성이 아니라 판정이라 구분선 아래로 내린다. 분포 바가 상태별 개수(범례)를 이미 말하므로
              여기 남는 숫자는 그 위의 집계뿐이다 — 특히 `evaluated` 는 "닫혔다"보다 강한 주장이라 따로 세운다. */}
          <div className="space-y-2.5 border-t border-border pt-3.5">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] font-[510] uppercase tracking-wide text-faint">
                {t('rollupTitle')}
              </p>
              {current.rollup.ready && <Badge tone="success">{t('rollupReady')}</Badge>}
            </div>
            {segments.length > 0 && <DistributionBar segments={segments} />}
            <PropertyList>
              <PropertyRow label={t('rollupOpen')}>
                <span className={cn('tabular-nums', current.rollup.open > 0 && 'text-destructive')}>
                  {current.rollup.open}
                </span>
              </PropertyRow>
              <PropertyRow label={t('rollupDone')}>
                <span className="tabular-nums">{current.rollup.done}</span>
              </PropertyRow>
              <PropertyRow
                label={
                  <span className="inline-flex items-center gap-1">
                    {t('rollupEvaluated')}
                    <InfoTip content={t('rollupEvaluatedTip')} />
                  </span>
                }
              >
                <span className="tabular-nums">{current.rollup.evaluated}</span>
              </PropertyRow>
            </PropertyList>
          </div>
        </aside>

        {/* ③ 프로젝트가 무엇이고, 그 아래에서 무슨 일이 벌어지고 있는지. */}
        <div className="min-w-0 space-y-7 @3xl:col-start-1 @3xl:row-start-1">
          {/* 설명은 이름 바로 아래에서 시작한다(섹션 제목 없이) — 이 화면의 본문은 프로젝트 그 자체다. */}
          {/* 목표(이니셔티브)의 설명과 같은 마크다운 표면 — 한 층 아래라고 다르게 읽힐 이유가 없다.
              ```mermaid 펜스가 다이어그램이 되는 것까지 같다. */}
          {current.description && <Markdown content={current.description} mermaid />}

          {grouped.length > 0 && (
            <section className="space-y-4">
              <SectionHeader title={t('issuesTitle', { count: issues.length })} />
              {grouped.map((group) => (
                <div key={group.status} className="space-y-2">
                  <p className="text-[11px] font-[510] uppercase tracking-wide text-faint">
                    {tracker(`issueStatus.${group.status}`)} · {group.items.length}
                  </p>
                  {group.items.map((issue) => (
                    <Link
                      key={issue.id}
                      href={issueHref(workspace, issue.identifier, issue.title)}
                      className={cn(
                        'flex items-center gap-3 rounded-lg border bg-card px-3.5 py-2 shadow-raise transition-colors hover:border-border-strong hover:bg-elevated',
                        issue.status === 'regressed' && 'border-destructive/40 bg-destructive/5'
                      )}
                    >
                      <IssueStatusIcon status={issue.status} />
                      <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                        {issue.title}
                      </span>
                      <time className="hidden shrink-0 font-mono text-[11px] text-muted-foreground @md:block">
                        {fmtDateTime(issue.updatedAt, timeZone)}
                      </time>
                    </Link>
                  ))}
                </div>
              ))}
            </section>
          )}

          {/* 마일스톤 — 프로젝트 안의 체크포인트. 순서가 곧 의미라 sortOrder 대로 세운다. */}
          {current.milestones.length > 0 && (
            <section className="space-y-3">
              <SectionHeader title={t('milestonesTitle', { count: current.milestones.length })} />
              <div className="space-y-1.5">
                {[...current.milestones]
                  .sort((a, b) => a.sortOrder - b.sortOrder)
                  .map((milestone) => (
                    <div
                      key={milestone.id}
                      className="flex flex-wrap items-center gap-3 rounded-lg border bg-card px-3 py-2 shadow-raise"
                    >
                      <Flag className="size-3.5 shrink-0 text-faint" />
                      <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                        {milestone.name}
                      </span>
                      {milestone.targetDate && (
                        <time className="shrink-0 font-mono text-[11px] text-muted-foreground">
                          {milestone.targetDate}
                        </time>
                      )}
                      <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                        {t('milestoneIssues', {
                          count: issues.filter((issue) => issue.milestoneId === milestone.id)
                            .length,
                        })}
                      </span>
                    </div>
                  ))}
              </div>
            </section>
          )}

          {/* 업데이트 — 트래커가 기록하는 유일한 판단. 색이 왜 바뀌었는지가 여기 문장으로 남는다. */}
          <section className="space-y-3">
            <SectionHeader title={t('updatesTitle')} />
            {canWrite && <ProjectUpdatePanel id={current.id} />}
            {updates.length > 0 && (
              <div className="space-y-2">
                {updates.map((update) => (
                  <article key={update.id} className="rounded-lg border bg-card p-3 shadow-raise">
                    <div className="flex flex-wrap items-center gap-2">
                      <HealthBadge health={update.health} />
                      <span className="text-[12px] text-muted-foreground">
                        {memberNameOf(actors, update.createdBy)}
                      </span>
                      <time
                        className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground"
                        dateTime={update.createdAt}
                        title={fmtDateTimeFull(update.createdAt, { timeZone })}
                      >
                        {fmtDateTime(update.createdAt, timeZone)}
                      </time>
                    </div>
                    <p className="mt-1.5 whitespace-pre-wrap text-[13px] leading-relaxed text-foreground">
                      {update.body}
                    </p>
                  </article>
                ))}
              </div>
            )}
          </section>

          {current.history.length > 0 && (
            <section className="space-y-3">
              <SectionHeader title={t('historyTitle')} />
              <TrackerHistory
                kind="project"
                subject={tracker('subject.project')}
                entries={current.history}
                actors={actors}
                workspace={workspace}
              />
            </section>
          )}

          <CommentsSection
            workspace={workspace}
            resourceType="project"
            resourceId={current.id}
            title={t('discussTitle')}
          />
        </div>
      </div>
    </div>
  )
}
