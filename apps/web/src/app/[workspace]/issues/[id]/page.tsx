import Link from 'next/link'
import { redirect } from 'next/navigation'
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  FolderKanban,
  Github,
  Link2,
} from 'lucide-react'
import { getTimeZone, getTranslations } from 'next-intl/server'

import { CommentsSection } from '@/features/discuss'
import { IssueGithubPanel } from '@/features/import-github-issues'
import { IssueEvaluationHistory, type IssueEvaluationEntry } from '@/features/issue-evaluation'
import { IssueLinks } from '@/features/issue-links'
import { IssueActions, IssueStatusControl } from '@/features/manage-issue'
import {
  ISSUE_CAPABILITY_LINK_TYPES,
  issueHref,
  issueSchema,
  issueScorecardsSchema,
  issuesSchema,
  type Issue,
} from '@/entities/issue'
import { memberDirectoryOf, memberNameOf, membersSchema, type Member } from '@/entities/member'
import { projectsSchema, type Project } from '@/entities/project'
import { TeamKeyBadge, teamWithSummarySchema, type TeamWithSummary } from '@/entities/team'
import { TrackerHistory } from '@/entities/tracker-history'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { fmtDateTime, fmtDateTimeFull } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { Avatar } from '@/shared/ui/avatar'
import { Badge } from '@/shared/ui/badge'
import { Callout } from '@/shared/ui/callout'
import { Card } from '@/shared/ui/card'
import { EntityRef } from '@/shared/ui/chip'
import { CopyLinkButton } from '@/shared/ui/copy-link-button'
import { Markdown } from '@/shared/ui/markdown'
import { PageHeader } from '@/shared/ui/page-header'
import { PropertyList, PropertyRow } from '@/shared/ui/property-list'
import { SectionHeader } from '@/shared/ui/section-header'

export const dynamic = 'force-dynamic'

// 위/아래 이동이 훑을 형제 이슈의 창. 목록 화면의 기본 정렬(최근 활동순)을 팀 범위로 다시 받아 "보던 목록의
// 다음 이슈"가 되게 한다. 창 밖으로 밀려난 이슈에서는 화살표가 비활성으로 남는다 — 팀 전체를 끌어오는 것보다 낫다.
const SIBLING_WINDOW = 200

function BackLink({ workspace, label }: { workspace: string; label: string }) {
  return (
    <Link
      href={`/${workspace}/issues`}
      className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
    >
      <ChevronLeft className="size-3.5" />
      {label}
    </Link>
  )
}

// 형제 이슈 사이의 위/아래 이동 — 헤더의 오른쪽 끝에 붙는다. 갈 곳이 없으면 사라지지 않고 비활성으로 남아
// 이동 버튼의 자리가 이슈마다 흔들리지 않게 한다.
function SiblingLink({
  workspace,
  issue,
  direction,
  label,
}: {
  workspace: string
  issue: Issue | undefined
  direction: 'prev' | 'next'
  label: string
}) {
  const Icon = direction === 'prev' ? ChevronUp : ChevronDown
  const shape = 'inline-flex size-6 items-center justify-center rounded'
  if (!issue) {
    return (
      <span aria-hidden className={cn(shape, 'text-border')}>
        <Icon className="size-4" />
      </span>
    )
  }
  return (
    <Link
      href={issueHref(workspace, issue.identifier)}
      aria-label={label}
      title={`${issue.identifier} · ${issue.title}`}
      className={cn(
        shape,
        'text-muted-foreground transition-colors hover:bg-accent hover:text-foreground'
      )}
    >
      <Icon className="size-4" />
    </Link>
  )
}

// One issue — the unit of intent, with the evidence that verifies it gathered in one place: what it links,
// how it was evaluated, what closed it, and (when it regressed) the baseline it fell from.
//
// 레이아웃은 Linear 이슈 뷰의 것이다. ① 상단 브레드크럼(이슈 → 팀 → 식별자)이 "이게 어디 있는 이슈인지"에
// 답하고, 그 옆에 이 이슈에 대한 작업(링크 복사·⋯)이, 오른쪽 끝에 형제 이슈 위/아래 이동이 붙는다.
// ② 제목은 크게 혼자 선다. ③ 본문(설명·증거·논의)은 왼쪽 열, ④ 속성은 전부 오른쪽 한 열. 읽는 자리와
// 바꾸는 자리를 섞지 않는 것이 이 레이아웃의 전부다.
export default async function IssueDetailPage({
  params,
}: {
  // `id` 세그먼트는 REF 다 — 슬러그(`ENG-12`)가 정규형이고, 예전에 복사된 uuid 링크도 제어 평면이 같이 받는다.
  params: Promise<{ workspace: string; id: string }>
}) {
  const { workspace, id: ref } = await params
  const t = await getTranslations('issuesPage')
  const tracker = await getTranslations('tracker')
  const timeZone = await getTimeZone()
  const { principal, ctx } = await currentPrincipal()

  let issue: Issue | undefined
  let error: string | undefined
  try {
    issue = issueSchema.parse(await controlPlane.getIssue(ctx, ref))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  if (!issue) {
    return (
      <div className="space-y-5">
        <BackLink workspace={workspace} label={t('backToList')} />
        <PageHeader title={t('detailFallbackTitle')} />
        <Callout tone="danger">{t('loadError', { error: error ?? '' })}</Callout>
      </div>
    )
  }
  const current = issue
  // 주소를 정규화한다 — uuid 로 들어왔거나 소문자로 붙여넣은 링크는 팀이 찍은 이름으로 바꿔 준다.
  if (ref !== current.identifier) redirect(issueHref(workspace, current.identifier))

  // Supplementary reads — the detail still renders if any of them fails, so they run together and a failure
  // degrades only its own slot (팀을 못 읽으면 브레드크럼이 한 칸 짧아질 뿐이다).
  const [evaluation, projects, members, team, siblings] = await Promise.all([
    controlPlane
      .listIssueScorecards(ctx, current.id)
      .then((r) => issueScorecardsSchema.parse(r))
      .catch(() => ({ scorecards: [], linked: [] })),
    controlPlane
      .listProjects(ctx)
      .then((r) => projectsSchema.parse(r))
      .catch((): Project[] => []),
    controlPlane
      .listMembers(ctx)
      .then((r) => membersSchema.parse(r))
      .catch((): Member[] => []),
    controlPlane
      .getTeam(ctx, current.teamId)
      .then((r) => teamWithSummarySchema.parse(r))
      .catch((): TeamWithSummary | undefined => undefined),
    controlPlane
      .listIssues(ctx, { team: current.teamId, limit: SIBLING_WINDOW })
      .then((r) => issuesSchema.parse(r))
      .catch((): Issue[] => []),
  ])

  const canWrite = can(principal?.roles ?? [], 'issues:write')
  const project = current.projectId ? projects.find((p) => p.id === current.projectId) : undefined
  // 이력·담당자·해결 기록이 같은 이름·같은 얼굴을 쓰도록 subject → 프로필을 한 번만 만든다.
  const actors = memberDirectoryOf(members)
  const displayName = (subject: string): string => memberNameOf(actors, subject)

  const at = siblings.findIndex((s) => s.id === current.id)
  const previous = at > 0 ? siblings[at - 1] : undefined
  const next = at >= 0 ? siblings[at + 1] : undefined

  const linked = new Set(evaluation.linked)
  const entries: IssueEvaluationEntry[] = evaluation.scorecards.map((s) => {
    const metric = s.summary?.find((m) => m.passRate != null) ?? s.summary?.[0]
    return {
      id: s.id,
      dataset: s.dataset,
      harness: s.harness,
      passRate: metric?.passRate ?? null,
      status: s.status,
      createdAt: s.createdAt,
      pinned: linked.has(s.id),
      baseline: current.resolution?.scorecardId === s.id,
    }
  })

  // The resolve dialog offers the scorecards this issue already has in view — the evidence is picked from
  // what actually ran against it, not typed from memory.
  const resolvable = evaluation.scorecards.map((s) => ({
    id: s.id,
    label: `${s.dataset.id} · ${s.harness.id} · ${fmtDateTime(s.createdAt, timeZone)}`,
  }))

  const assignee = current.assignee
  const assigneeAvatar = assignee ? actors[assignee]?.avatarUrl : undefined
  // 속성 열이 보여주는 링크 = 이슈를 검증하는 능력(하니스·데이터셋·평가자)뿐. 스코어카드 링크는 증거이고
  // 아래 "평가 이력"이 이미 고정 배지로 보여주므로, 여기 세면 빈 섹션 판정이 틀어진다.
  const capabilityLinks = current.links.filter((link) =>
    ISSUE_CAPABILITY_LINK_TYPES.some((kind) => kind === link.type)
  )

  return (
    <div className="@container">
      {/* ① 위치와 작업이 왼쪽, 형제 이슈 이동이 오른쪽 끝 — 이 두 무리를 섞지 않는다. */}
      <div className="flex items-center justify-between gap-3 border-b border-border pb-2.5">
        <div className="flex min-w-0 items-center gap-1">
          <nav
            aria-label={t('breadcrumbLabel')}
            className="flex min-w-0 items-center gap-1 text-[12.5px]"
          >
            <Link
              href={`/${workspace}/issues`}
              className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
            >
              {t('title')}
            </Link>
            {team && (
              <>
                <ChevronRight className="size-3 shrink-0 text-faint" />
                <Link
                  href={`/${workspace}/teams/${encodeURIComponent(team.id)}`}
                  className="truncate text-muted-foreground transition-colors hover:text-foreground"
                >
                  {team.name}
                </Link>
              </>
            )}
            <ChevronRight className="size-3 shrink-0 text-faint" />
            {/* 사람이 부르는 이름 — 제목 앞이 아니라 여기, 주소와 같은 자리에 둔다. */}
            <span className="shrink-0 font-mono text-[12px] font-[510] text-foreground">
              {current.identifier}
            </span>
          </nav>
          <CopyLinkButton label={t('copyLink')} message={t('linkCopied')} className="ml-0.5" />
          {canWrite && (
            <IssueActions
              workspace={workspace}
              issue={current}
              projects={projects.map((p) => ({ id: p.id, name: p.name }))}
            />
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <SiblingLink
            workspace={workspace}
            issue={previous}
            direction="prev"
            label={t('prevIssue')}
          />
          <SiblingLink workspace={workspace} issue={next} direction="next" label={t('nextIssue')} />
        </div>
      </div>

      {/* ② 이슈 페이지에서 가장 크게 들어와야 하는 한 가지. 자유 텍스트라 자르지 않고 줄바꿈한다. */}
      <h1 className="break-words pt-5 text-[22px] font-[560] leading-[1.3] tracking-[-0.01em] text-foreground">
        {current.title}
      </h1>

      <div className="grid gap-x-8 gap-y-6 pt-5 @3xl:grid-cols-[minmax(0,1fr)_17rem]">
        {/* ④ 속성은 한 열에 모은다. 좁을 때는 제목 바로 아래로 접히므로(본문보다 먼저 읽힌다) 아래쪽에
            경계선을 둬서 속성 묶음과 본문이 한 덩어리로 뭉개지지 않게 한다. 두 열일 때는 필요 없다. */}
        <aside className="min-w-0 space-y-3.5 border-b border-border pb-6 @3xl:col-start-2 @3xl:row-start-1 @3xl:self-start @3xl:border-b-0 @3xl:pb-0">
          <PropertyList>
            <PropertyRow label={t('fieldStatus')}>
              <IssueStatusControl
                id={current.id}
                status={current.status}
                canWrite={canWrite}
                scorecards={resolvable}
              />
            </PropertyRow>
            {assignee && (
              <PropertyRow label={t('fieldAssignee')}>
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <Avatar
                    name={displayName(assignee)}
                    size="sm"
                    {...(assigneeAvatar !== undefined ? { url: assigneeAvatar } : {})}
                  />
                  <span className="truncate">{displayName(assignee)}</span>
                </span>
              </PropertyRow>
            )}
            {team && (
              <PropertyRow label={t('fieldTeam')}>
                <Link
                  href={`/${workspace}/teams/${encodeURIComponent(team.id)}`}
                  className="inline-flex min-w-0 items-center gap-1.5 transition-colors hover:text-foreground"
                >
                  <TeamKeyBadge teamKey={team.key} />
                  <span className="truncate">{team.name}</span>
                </Link>
              </PropertyRow>
            )}
            {project && (
              <PropertyRow label={t('fieldProject')}>
                <Link
                  href={`/${workspace}/projects/${encodeURIComponent(project.id)}`}
                  className="inline-flex min-w-0 items-center gap-1.5 transition-colors hover:text-foreground"
                >
                  <FolderKanban className="size-3.5 shrink-0 text-faint" />
                  <span className="truncate">{project.name}</span>
                </Link>
              </PropertyRow>
            )}
            {current.labels.length > 0 && (
              <PropertyRow label={t('fieldLabels')}>
                <span className="flex flex-wrap gap-1">
                  {current.labels.map((label) => (
                    <Badge key={label} tone="outline">
                      {label}
                    </Badge>
                  ))}
                </span>
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
            {current.updatedAt !== current.createdAt && (
              <PropertyRow label={t('metaUpdated')}>
                <time
                  dateTime={current.updatedAt}
                  title={fmtDateTimeFull(current.updatedAt, { timeZone })}
                >
                  {fmtDateTime(current.updatedAt, timeZone)}
                </time>
              </PropertyRow>
            )}
            {/* `github` 는 가져오기로만 붙는다(기존 이슈를 나중에 연결하는 경로가 없다) — 그래서 이 행은
                "GitHub"이 아니라 이 이슈가 어디서 왔는지를 말한다. 전체 주소는 title 에 담아 GHE 호스트도
                확인할 수 있게 한다. */}
            {current.github && (
              <PropertyRow label={t('importedFrom')}>
                <a
                  href={current.github.url}
                  target="_blank"
                  rel="noreferrer"
                  title={current.github.url}
                  className="inline-flex min-w-0 items-center gap-1.5 transition-colors hover:text-foreground"
                >
                  <Github className="size-3.5 shrink-0 text-faint" />
                  <span className="truncate">
                    {current.github.repository}#{current.github.number}
                  </span>
                </a>
              </PropertyRow>
            )}
          </PropertyList>

          {/* 이 이슈를 검증하는 자산들 — 속성 중 유일하게 편집 폼을 달고 있어 구분선 아래로 내린다.
              @container 는 그 폼이 좁은 사이드바에서 세로로 접히도록 자기 너비를 재게 하려는 것이다.
              세는 것도 능력 링크만: 스코어카드만 걸려 있는 이슈에 빈 섹션이 서면 안 된다(빈 섹션 숨김). */}
          {(capabilityLinks.length > 0 || canWrite) && (
            <div className="@container space-y-2 border-t border-border pt-3.5">
              <p className="text-[11px] font-[510] uppercase tracking-wide text-faint">
                {t('linksTitle')}
              </p>
              <IssueLinks
                workspace={workspace}
                issueId={current.id}
                links={current.links}
                canWrite={canWrite}
              />
            </div>
          )}
        </aside>

        {/* ③ 이슈의 맥락과 증거, 그리고 논의. */}
        <div className="min-w-0 space-y-7 @3xl:col-start-1 @3xl:row-start-1">
          {/* 설명은 제목 바로 아래에서 시작한다(섹션 제목 없이) — 이 화면의 본문은 이슈 그 자체다.
              An imported GitHub issue's body IS markdown — render it as such (GFM), never as flat text. */}
          {current.description && <Markdown content={current.description} />}

          {/* Only an imported issue has a remote half — an issue filed here shows nothing (hide-empty rule). */}
          {current.github && (
            <section className="space-y-3">
              <SectionHeader title={t('githubTitle')} />
              <IssueGithubPanel issueId={current.id} github={current.github} canWrite={canWrite} />
            </section>
          )}

          {entries.length > 0 && (
            <section className="space-y-3">
              <SectionHeader
                title={t('evaluationTitle')}
                action={
                  <span className="text-[12px] tabular-nums text-faint">
                    {t('evaluationCount', { count: entries.length })}
                  </span>
                }
              />
              <IssueEvaluationHistory workspace={workspace} entries={entries} timeZone={timeZone} />
            </section>
          )}

          {/* The resolution is KEPT across a reopen on purpose — a regressed issue must still show the
              scorecard it fell from, because that is the baseline the regression was measured against. */}
          {current.resolution && (
            <section className="space-y-3">
              <SectionHeader title={t('resolutionTitle')} />
              <Card className="space-y-2.5 p-4">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12.5px] text-muted-foreground">
                  <span>
                    {t('resolutionBy', {
                      name: displayName(current.resolution.by),
                      at: fmtDateTime(current.resolution.at, timeZone),
                    })}
                  </span>
                  {current.status === 'regressed' && (
                    <Badge tone="danger">{t('resolutionRegressed')}</Badge>
                  )}
                </div>
                {current.resolution.scorecardId && (
                  <Link
                    href={`/${workspace}/scorecards/${encodeURIComponent(current.resolution.scorecardId)}`}
                    className="inline-flex items-center gap-1.5 text-[12.5px] transition-colors hover:text-foreground"
                  >
                    <Link2 className="size-3.5 text-faint" />
                    <EntityRef id={current.resolution.scorecardId} />
                  </Link>
                )}
                {current.resolution.note && (
                  <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground">
                    {current.resolution.note}
                  </p>
                )}
              </Card>
            </section>
          )}

          {current.history.length > 0 && (
            <section className="space-y-3">
              <SectionHeader title={t('historyTitle')} />
              <TrackerHistory
                kind="issue"
                subject={tracker('subject.issue')}
                entries={current.history}
                actors={actors}
                workspace={workspace}
              />
            </section>
          )}

          <CommentsSection
            workspace={workspace}
            resourceType="issue"
            resourceId={current.id}
            title={t('discussTitle')}
          />
        </div>
      </div>
    </div>
  )
}
