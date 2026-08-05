import { redirect } from 'next/navigation'
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Github, Link2 } from 'lucide-react'
import { getTimeZone, getTranslations } from 'next-intl/server'

import { MentionInChatButton } from '@/widgets/infra-panel'
import { CommentsSection } from '@/features/discuss'
import { IssueGithubPanel } from '@/features/import-github-issues'
import { IssueEvaluationHistory, type IssueEvaluationEntry } from '@/features/issue-evaluation'
import { IssueLinks } from '@/features/issue-links'
import {
  CreateIssueButton,
  IssueActions,
  IssueAssigneeControl,
  IssueCycleControl,
  IssueLabelControl,
  IssuePriorityControl,
  IssueProjectControl,
  IssueStatusControl,
  IssueTeamControl,
  IssueTriageActions,
} from '@/features/manage-issue'
import {
  cycleHref,
  cycleLabel,
  cyclesSchema,
  cycleStateOf,
  todayIso,
  type Cycle,
} from '@/entities/cycle'
import {
  isOpenIssueStatus,
  ISSUE_CAPABILITY_LINK_TYPES,
  issueAttachmentProxy,
  issueHref,
  issuePageSchema,
  IssuePriorityIcon,
  issueSchema,
  issueScorecardsSchema,
  IssueStatusIcon,
  type Issue,
  type IssueSummary,
} from '@/entities/issue'
import { issueLabelsSchema, type IssueLabel } from '@/entities/issue-label'
import { memberDirectoryOf, memberNameOf, membersSchema, type Member } from '@/entities/member'
import { isPastDue, projectsSchema, type Project } from '@/entities/project'
import {
  teamHref,
  teamsWithSummarySchema,
  teamWithSummarySchema,
  type TeamWithSummary,
} from '@/entities/team'
import { TrackerHistory } from '@/entities/tracker-history'
import { workflowStatesSchema, type WorkflowState } from '@/entities/workflow-state'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { fmtDateTime, fmtDateTimeFull } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { Callout } from '@/shared/ui/callout'
import { Card } from '@/shared/ui/card'
import { EntityRef } from '@/shared/ui/chip'
import { CopyLinkButton } from '@/shared/ui/copy-link-button'
import { Link } from '@/shared/ui/link'
import { Markdown } from '@/shared/ui/markdown'
import { MediaLightbox } from '@/shared/ui/media-lightbox'
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
  // 이웃은 목록에서 온 축약본이다 — 화살표는 식별자와 제목만 필요하므로 전체 레코드를 읽을 이유가 없다.
  issue: IssueSummary | undefined
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
      href={issueHref(workspace, issue.identifier, issue.title)}
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
  // The trailing segment is the title slug — decorative, never read. It exists so a pasted link says what it
  // leads to; the identifier alone decides which issue this is, and `/issue/ENG-12` with no slug is just as valid.
  params: Promise<{ workspace: string; id: string; slug?: string[] }>
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
  if (ref !== current.identifier) redirect(issueHref(workspace, current.identifier, current.title))

  // Supplementary reads — the detail still renders if any of them fails, so they run together and a failure
  // degrades only its own slot (팀을 못 읽으면 브레드크럼이 한 칸 짧아질 뿐이다).
  const [
    evaluation,
    projects,
    members,
    team,
    teams,
    states,
    siblings,
    labels,
    children,
    cycles,
    parent,
  ] = await Promise.all([
    controlPlane
      .listIssueScorecards(ctx, current.id)
      .then((r) => issueScorecardsSchema.parse(r))
      .catch(() => ({ scorecards: [], linked: [] })),
    // 이 이슈가 들어갈 수 있는 프로젝트 — 자기 팀의 것뿐이다. 프로젝트는 자기 팀들을 이름으로 들고 있고,
    // 이슈는 자기 팀이 올라 있는 프로젝트에만 들어간다(제어 평면이 거부한다). 워크스페이스 전체를 그려 놓으면
    // 고를 수는 있는데 저장은 실패하는 항목이 목록의 대부분이 된다.
    controlPlane
      .listProjects(ctx, { team: current.teamId })
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
    // 팀 목록은 "다른 팀으로 넘기기" 하나 때문에 읽는다 — 컨트롤이 고를 것이 없으면 드롭다운을 내지 않는다.
    controlPlane
      .listTeams(ctx)
      .then((r) => teamsWithSummarySchema.parse(r))
      .catch((): TeamWithSummary[] => []),
    // 이 이슈가 속한 팀의 보드 — 상태 드롭다운이 팀이 붙인 이름을 쓴다.
    controlPlane
      .listWorkflowStates(ctx, current.teamId)
      .then((r) => workflowStatesSchema.parse(r))
      .catch((): WorkflowState[] => []),
    controlPlane
      .listIssues(ctx, { team: current.teamId, limit: SIBLING_WINDOW })
      .then((r) => issuePageSchema.parse(r).items)
      .catch((): IssueSummary[] => []),
    controlPlane
      .listIssueLabels(ctx)
      .then((r) => issueLabelsSchema.parse(r))
      .catch((): IssueLabel[] => []),
    // 하위 이슈 — 목록 투영이면 충분하다(행이 그리는 것만 그린다).
    controlPlane
      .listIssues(ctx, { parent: current.id })
      .then((r) => issuePageSchema.parse(r).items)
      .catch((): IssueSummary[] => []),
    // 이 이슈가 들어갈 수 있는 이터레이션 — 자기 팀의 것뿐이다(제어 평면이 거절한다). 이미 붙어 있는
    // 사이클도 이 목록 안에 있으므로 읽기는 하나면 된다. 사이클을 쓰지 않는 팀에서는 빈 목록이 온다.
    controlPlane
      .listCycles(ctx, { team: current.teamId })
      .then((r) => cyclesSchema.parse(r))
      .catch((): Cycle[] => []),
    current.parentId === undefined
      ? Promise.resolve(undefined)
      : controlPlane
          .getIssue(ctx, current.parentId)
          .then((r) => issueSchema.parse(r))
          .catch((): Issue | undefined => undefined),
  ])

  const canWrite = can(principal?.roles ?? [], 'issues:write')
  // 설명에 파일을 붙이는 것은 워크스페이스 파일시스템에 쓰는 일이다 — 이슈 쓰기와 같은 등급(member+)이지만
  // 판정은 그 권한으로 한다.
  const canAttach = can(principal?.roles ?? [], 'files:write')
  // 닫힌 이슈의 지난 기한은 경고가 아니다 — 이미 끝난 일에 붉은 배지를 다는 건 소음이다.
  const dueOverdue =
    current.status !== 'done' &&
    current.status !== 'cancelled' &&
    isPastDue(current.dueDate, timeZone)
  const project = current.projectId ? projects.find((p) => p.id === current.projectId) : undefined
  // 이터레이션. 주소는 팀 아래의 번호(`…/teams/ENG/cycles/7`)이고, 팀을 못 읽었을 때만 예전 주소로 보낸다
  // (그 주소가 팀을 찾아 정식 주소로 넘겨 준다) — 링크가 죽는 경우는 만들지 않는다.
  const today = todayIso()
  const cycleHrefOf = (c: Cycle): string =>
    team
      ? cycleHref(workspace, team.key, c.number)
      : `/${workspace}/cycle/${encodeURIComponent(c.id)}`
  const cycleOptionOf = (c: Cycle) => ({
    id: c.id,
    label: cycleLabel(c),
    state: cycleStateOf(c, today),
    href: cycleHrefOf(c),
  })
  const cycle = current.cycleId ? cycles.find((c) => c.id === current.cycleId) : undefined
  // 고를 수 있는 것은 열려 있는 이터레이션뿐이다 — 닫힌 주기는 계획이 아니라 기록이고, 거기에 새 일을 넣는 것은
  // 어느 팀도 하려는 일이 아니다.
  const cycleOptions = cycles.filter((c) => c.completedAt === undefined).map(cycleOptionOf)
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
  // 맡길 수 있는 사람 — 지금 워크스페이스 멤버인 사람뿐이다. `actors` 는 이미 나간 사람의 이름까지 알지만
  // (예전 이슈의 담당자·이력을 그려야 하므로), 새로 맡길 수 있는 건 이쪽이다.
  const assignableMembers = members.map((m) => ({
    subject: m.subject,
    name: actors[m.subject]?.name ?? m.subject,
    ...(m.avatarUrl !== undefined ? { avatarUrl: m.avatarUrl } : {}),
  }))
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
                  href={teamHref(workspace, team.key)}
                  className="truncate text-muted-foreground transition-colors hover:text-foreground"
                >
                  {team.name}
                </Link>
              </>
            )}
            {parent && (
              <>
                <ChevronRight className="size-3 shrink-0 text-faint" />
                {/* 하위 이슈는 부모를 경로에 이고 다닌다 — 이 이슈가 무엇에서 쪼개져 나왔는지가 곧 위치다. */}
                <Link
                  href={issueHref(workspace, parent.identifier, parent.title)}
                  title={parent.title}
                  className="truncate text-muted-foreground transition-colors hover:text-foreground"
                >
                  <span className="font-mono text-[12px]">{parent.identifier}</span>
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
          {/* 이 이슈를 에이전트 대화의 맥락으로 넘긴다 — 다른 상세와 같은 진입이되, 이 헤더는 아이콘 줄이라
              캡션을 접는다. 참조 키는 UUID 가 아니라 식별자(ENG-12) — @-피커가 만드는 참조와 같은 모양이라야
              같은 이슈를 두 번 붙이는 일이 없고, 에이전트가 읽는 맥락 머리글에도 사람이 부르는 이름이 남는다.
              `fresh`: 스킬 편집 진입처럼 새 대화에서 시작한다 — 이 대화의 주제는 "이 이슈"이지 열려 있던
              스레드의 주제가 아니고, 임무 프레이밍은 빈 화면에서만 뜨므로 얹기만 하면 아무것도 안 바뀐다. */}
          <MentionInChatButton
            compact
            fresh
            mission="issueAnalyze"
            reference={{ type: 'issue', id: current.identifier, label: current.title }}
          />
          {canWrite && (
            <IssueActions
              workspace={workspace}
              issue={current}
              projects={projects.map((p) => ({ id: p.id, name: p.name }))}
              labels={labels}
              canWrite={canWrite}
              canAttach={canAttach}
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
                states={states.map((state) => ({
                  id: state.id,
                  name: state.name,
                  status: state.status,
                }))}
              />
            </PropertyRow>
            <PropertyRow label={t('fieldPriority')}>
              <IssuePriorityControl
                id={current.id}
                priority={current.priority}
                canWrite={canWrite}
              />
            </PropertyRow>
            {/* 담당자도 이 열에서 바로 지정하고 뗀다 — 예전에는 이미 맡은 사람이 있을 때만 이름 한 줄이
                떴고, 이슈를 열어 놓고도 사람을 지정할 길이 상세 화면 어디에도 없었다(목록 행으로 돌아가야
                했다). 쓸 수 있는 사람에게는 비어 있어도 행을 낸다 — 읽기 전용일 때만 빈 행을 숨긴다. */}
            {(canWrite || assignee !== undefined) && (
              <PropertyRow label={t('fieldAssignee')}>
                <IssueAssigneeControl
                  id={current.id}
                  {...(assignee !== undefined ? { assignee } : {})}
                  actors={actors}
                  members={assignableMembers}
                  canWrite={canWrite}
                />
              </PropertyRow>
            )}
            <PropertyRow label={t('fieldTeam')}>
              {/* 팀은 상태와 함께 속성 열 안에서 바꿀 수 있는 둘뿐인 속성이다 — 옮기면 식별자가 다시 찍히므로
                  컨트롤이 성공 후 새 슬러그로 주소를 바꾼다. */}
              <IssueTeamControl
                workspace={workspace}
                id={current.id}
                {...(team !== undefined
                  ? { team: { id: team.id, key: team.key, name: team.name } }
                  : { team: undefined })}
                teams={teams.map((x) => ({ id: x.id, key: x.key, name: x.name }))}
                canWrite={canWrite}
              />
            </PropertyRow>
            {/* 프로젝트도 이 열에서 바로 넣고 뺀다 — 붙어 있을 때만 보이던 링크 한 줄로는 "이 이슈를 어느
                프로젝트에 넣을까"에 답할 자리가 화면 어디에도 없었다(편집 다이얼로그 안에만 있었다).
                고를 프로젝트가 하나도 없는 워크스페이스에서는 빈 행을 내지 않는다(빈 섹션 숨김). */}
            {(project !== undefined || (canWrite && projects.length > 0)) && (
              <PropertyRow label={t('fieldProject')}>
                <IssueProjectControl
                  workspace={workspace}
                  id={current.id}
                  project={
                    project
                      ? { id: project.id, name: project.name, status: project.status }
                      : undefined
                  }
                  projects={projects.map((p) => ({ id: p.id, name: p.name, status: p.status }))}
                  canWrite={canWrite}
                />
              </PropertyRow>
            )}
            {/* 사이클도 이 열에서 바로 넣고 뺀다 — 예전에는 붙어 있을 때만 링크 한 줄로 보였고, "이 이슈를
                이번 주기에 넣자"에 답할 자리가 화면 어디에도 없었다(사이클을 만들 수는 있는데 이슈를 넣을
                길이 없었다). 사이클을 쓰지 않는 팀에서는 빈 행을 내지 않는다(빈 섹션 숨김). */}
            {(cycle !== undefined || (canWrite && cycleOptions.length > 0)) && (
              <PropertyRow label={t('fieldCycle')}>
                <IssueCycleControl
                  id={current.id}
                  cycle={cycle ? cycleOptionOf(cycle) : undefined}
                  cycles={cycleOptions}
                  canWrite={canWrite}
                />
              </PropertyRow>
            )}
            {current.estimate !== undefined && (
              <PropertyRow label={t('fieldEstimate')}>
                <span className="font-mono tabular-nums">{current.estimate}</span>
              </PropertyRow>
            )}
            {current.dueDate !== undefined && (
              <PropertyRow label={t('fieldDueDate')}>
                {/* 기한은 지났을 때만 색이 붙는다 — 안 지난 날짜에까지 색을 주면 경고가 배경이 된다. */}
                <span
                  className={cn(
                    'inline-flex flex-wrap items-center gap-1.5',
                    dueOverdue && 'text-destructive'
                  )}
                >
                  <time dateTime={current.dueDate}>{current.dueDate}</time>
                  {dueOverdue && <Badge tone="danger">{t('overdue')}</Badge>}
                </span>
              </PropertyRow>
            )}
            {/* 라벨은 이 열에서 바로 붙였다 뗀다 — 쓸 수 있는 사람에게는 비어 있어도 행을 낸다(붙일 자리가
                화면 어디에도 없으면 "편집할 수 없는 속성"이 된다). 읽기 전용일 때만 빈 행을 숨긴다. */}
            {(canWrite || current.labelIds.length > 0) && (
              <PropertyRow label={t('fieldLabels')}>
                <IssueLabelControl
                  id={current.id}
                  labelIds={current.labelIds}
                  labels={labels}
                  canWrite={canWrite}
                />
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

        {/* ③ 이슈의 맥락과 증거, 그리고 논의.
            본문 열 전체를 확대 뷰어로 감싼다 — 설명·GitHub 코멘트·논의에 실린 그림이 한 묶음의 좌우 이동이
            되어야, 스크린샷을 비교하려고 이슈를 떠날 이유가 없어진다. */}
        <MediaLightbox className="min-w-0 space-y-7 @3xl:col-start-1 @3xl:row-start-1">
          {/* 설명은 제목 바로 아래에서 시작한다(섹션 제목 없이) — 이 화면의 본문은 이슈 그 자체다.
              An imported GitHub issue's body IS markdown — render it as such (GFM), never as flat text. */}
          {/* imageProxy: 본문의 GitHub 첨부 이미지는 브라우저가 직접 못 받아온다(GHE·비공개 리포는 리포와 같은
              인증 뒤에 있고 크로스사이트 img 요청에는 그 세션이 안 실린다) — 우리 라우트를 거쳐 서버가 받아온다. */}
          {/* 트리아지에 있는 이슈에 지금 할 일은 "받을까 말까" 하나뿐이라, 본문 맨 위에 선다. */}
          {current.inTriage && canWrite && <IssueTriageActions id={current.id} />}

          {current.description && (
            <Markdown
              content={current.description}
              imageProxy={issueAttachmentProxy(current.id, current.github)}
            />
          )}

          {/* 하위 이슈 — 빈 섹션은 내지 않는다(하우스 규칙). 진행도는 저장하지 않고 여기서 센다: 이슈 목록을
              이미 들고 있으니 산술이 공짜고, 저장했다면 자식이 움직일 때마다 무효화해야 할 캐시가 된다. */}
          {children.length > 0 && (
            <section className="space-y-3">
              <SectionHeader
                title={t('subIssuesTitle', { count: children.length })}
                action={
                  <>
                    <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                      {t('subIssuesProgress', {
                        done: children.filter((child) => !isOpenIssueStatus(child.status)).length,
                        total: children.length,
                      })}
                    </span>
                    {canWrite && (
                      <CreateIssueButton
                        workspace={workspace}
                        projects={projects.map((p) => ({ id: p.id, name: p.name }))}
                        parentId={current.id}
                        label={t('subIssueAdd')}
                      />
                    )}
                  </>
                }
              />
              <div className="space-y-1.5">
                {children.map((child) => (
                  <Link
                    key={child.id}
                    href={issueHref(workspace, child.identifier, child.title)}
                    className="flex items-center gap-2.5 rounded-lg border bg-card px-3 py-2 shadow-raise transition-colors hover:border-border-strong hover:bg-elevated"
                  >
                    <IssueStatusIcon status={child.status} />
                    <IssuePriorityIcon priority={child.priority} />
                    <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                      {child.identifier}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                      {child.title}
                    </span>
                  </Link>
                ))}
              </div>
            </section>
          )}

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
                    href={`/${workspace}/scorecard/${encodeURIComponent(current.resolution.scorecardId)}`}
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
        </MediaLightbox>
      </div>
    </div>
  )
}
