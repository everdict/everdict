import { redirect } from 'next/navigation'
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Github, Link2 } from 'lucide-react'
import { getTimeZone, getTranslations } from 'next-intl/server'

import { MentionInChatButton } from '@/widgets/infra-panel'
import { CommentsSection } from '@/features/discuss'
import { IssueGithubPanel } from '@/features/import-github-issues'
import { IssueEvaluationHistory, type IssueEvaluationEntry } from '@/features/issue-evaluation'
import {
  IssueCapabilityControl,
  IssueMentionControl,
  IssueTimelineLinkControl,
  type CapabilityOption,
} from '@/features/issue-links'
import { productsSchema, releaseSchema, type Product as TimelineProduct, type Release } from '@/entities/product'
import {
  CreateIssueButton,
  IssueActions,
  IssueAssigneeControl,
  IssueLabelControl,
  IssueMilestoneControl,
  IssueParentControl,
  IssuePriorityControl,
  IssueProjectControl,
  IssueStatusControl,
} from '@/features/manage-issue'
import { datasetsSchema, type DatasetSummary } from '@/entities/dataset'
import { harnessesSchema, type Harness } from '@/entities/harness'
import {
  isOpenIssueStatus,
  ISSUE_CAPABILITY_LINK_TYPES,
  ISSUE_MENTION_LINK_TYPES,
  issueAttachmentProxy,
  issueHref,
  issuePageSchema,
  IssuePriorityIcon,
  issueSchema,
  issueScorecardsSchema,
  IssueStatusIcon,
  type Issue,
  type IssueCapabilityLinkType,
  type IssueOption,
  type IssueSummary,
} from '@/entities/issue'
import { issueLabelsSchema, type IssueLabel } from '@/entities/issue-label'
import { judgesSchema, type JudgeSummary } from '@/entities/judge'
import { memberDirectoryOf, memberNameOf, membersSchema, type Member } from '@/entities/member'
import { isPastDue, projectsSchema, type Project } from '@/entities/project'
import { TrackerHistory } from '@/entities/tracker-history'
import { workflowStatesSchema, type WorkflowState } from '@/entities/workflow-state'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { fmtDateTime, fmtDateTimeFull } from '@/shared/lib/format'
import { searchSuffix } from '@/shared/lib/search-suffix'
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

// 한 이슈가 손으로 걸 만한 언급의 수 — 양쪽 방향 모두에 걸린다. 이보다 많이 걸린 이슈는 언급이 아니라
// 목록을 만든 것이고, 속성 열은 목록을 그리는 자리가 아니다.
const MENTION_WINDOW = 20

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
  searchParams,
}: {
  // `id` 세그먼트는 REF 다 — 슬러그(`ENG-12`)가 정규형이고, 예전에 복사된 uuid 링크도 제어 평면이 같이 받는다.
  // The trailing segment is the title slug — decorative, never read. It exists so a pasted link says what it
  // leads to; the identifier alone decides which issue this is, and `/issue/ENG-12` with no slug is just as valid.
  params: Promise<{ workspace: string; id: string; slug?: string[] }>
  // Read only to be handed on when the address normalizes below — a mention notification arrives at the uuid
  // carrying `?comment=<id>`, and that is what tells the thread which comment to scroll to.
  searchParams: Promise<Record<string, string | string[] | undefined>>
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
  // 알림이 들고 온 `?comment=` 는 그대로 넘긴다(리다이렉트를 건너뛰면 언급된 댓글에 영영 못 닿는다).
  if (ref !== current.identifier)
    redirect(
      `${issueHref(workspace, current.identifier, current.title)}${searchSuffix(await searchParams)}`
    )

  // Supplementary reads — the detail still renders if any of them fails, so they run together and a failure
  // degrades only its own slot.
  const [
    evaluation,
    projects,
    members,
    states,
    siblings,
    labels,
    children,
    parent,
    harnesses,
    datasets,
    judges,
    mentionedBy,
    timelineProducts,
    releases,
  ] = await Promise.all([
    controlPlane
      .listIssueScorecards(ctx, current.id)
      .then((r) => issueScorecardsSchema.parse(r))
      .catch(() => ({ scorecards: [], linked: [] })),
    // 이 이슈가 들어갈 수 있는 프로젝트 — 워크스페이스의 것 전부다.
    controlPlane
      .listProjects(ctx, {})
      .then((r) => projectsSchema.parse(r))
      .catch((): Project[] => []),
    controlPlane
      .listMembers(ctx)
      .then((r) => membersSchema.parse(r))
      .catch((): Member[] => []),
    // 워크스페이스의 보드 — 상태 드롭다운이 거기 붙은 이름을 쓴다.
    controlPlane
      .listWorkflowStates(ctx)
      .then((r) => workflowStatesSchema.parse(r))
      .catch((): WorkflowState[] => []),
    controlPlane
      .listIssues(ctx, { limit: SIBLING_WINDOW })
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
    current.parentId === undefined
      ? Promise.resolve(undefined)
      : controlPlane
          .getIssue(ctx, current.parentId)
          .then((r) => issueSchema.parse(r))
          .catch((): Issue | undefined => undefined),
    // 이 이슈를 검증하는 능력으로 고를 수 있는 것들 — 워크스페이스에 등록된 하네스·데이터셋·저지 전부다.
    controlPlane
      .listHarnesses(ctx)
      .then((r) => harnessesSchema.parse(r))
      .catch((): Harness[] => []),
    controlPlane
      .listDatasets(ctx)
      .then((r) => datasetsSchema.parse(r))
      .catch((): DatasetSummary[] => []),
    controlPlane
      .listJudges(ctx)
      .then((r) => judgesSchema.parse(r))
      .catch((): JudgeSummary[] => []),
    // 이 이슈를 **언급한** 이슈들 — 링크는 언급하는 쪽에만 저장되므로, 언급당한 쪽에서 알려면 이 방향으로
    // 물어보는 수밖에 없다(하네스 상세가 자기를 지켜보는 이슈를 찾는 것과 같은 질의).
    controlPlane
      .listIssues(ctx, { linkType: 'issue', linkId: current.id, limit: MENTION_WINDOW })
      .then((r) => issuePageSchema.parse(r).items)
      .catch((): IssueSummary[] => []),
    // 프로덕트 타임라인의 두 줄(프로덕트·릴리즈) — 링크는 UUID 를 저장하므로 이름으로 풀어 그릴 목록이
    // 필요하고, 릴리즈 게이트가 이 링크를 세므로 고르는 것이 곧 게이트의 근거가 된다.
    controlPlane
      .listProducts(ctx)
      .then((r) => productsSchema.parse(r))
      .catch((): TimelineProduct[] => []),
    controlPlane
      .listReleases(ctx)
      .then((r) => releaseSchema.array().parse(r))
      .catch((): Release[] => []),
  ])

  // 이 이슈가 언급한 이슈들 — 링크는 UUID 만 들고 있어 그 자체로는 아무 말도 하지 않는다. 그리려면 식별자·
  // 제목·상태가 필요하므로 하나씩 읽는다(언급은 손으로 거는 것이라 몇 개뿐이고, 못 읽은 것은 조용히 빠진다:
  // 지워졌거나 볼 수 없는 이슈를 UUID 한 줄로 그리면 아무에게도 도움이 안 된다).
  const mentions: IssueOption[] = (
    await Promise.all(
      current.links
        .filter((link) => link.type === 'issue')
        .slice(0, MENTION_WINDOW)
        .map((link) =>
          controlPlane
            .getIssue(ctx, link.id)
            .then((r) => issueSchema.parse(r))
            .catch((): Issue | undefined => undefined)
        )
    )
  )
    .filter((issue): issue is Issue => issue !== undefined)
    .map((issue) => ({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      status: issue.status,
    }))

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
  // 체크포인트는 프로젝트 안에서만 산다 — 고를 수 있는 것은 이 이슈가 들어가 있는 프로젝트의 것뿐이고(제어
  // 평면이 그렇게 판정한다), 프로젝트를 읽을 때 이미 함께 온다(읽기가 하나도 늘지 않는다). 순서는 프로젝트
  // 상세가 그리는 순서와 같아야 한다 — 같은 목록이 두 화면에서 다른 차례로 보이면 안 된다.
  const milestoneOptions = [...(project?.milestones ?? [])]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((m) => ({ id: m.id, name: m.name, ...(m.targetDate ? { targetDate: m.targetDate } : {}) }))
  const milestone = current.milestoneId
    ? milestoneOptions.find((m) => m.id === current.milestoneId)
    : undefined
  // 상위로 세울 수 있는 이슈 — 워크스페이스의 이슈들이다. 형제 이동이 이미 읽어 둔 창을 그대로 쓰므로 읽기가
  // 하나 늘지 않는다. 자기 자신과 자기 하위 이슈는 뺀다(자기 자손 아래로 들어가면 고리가 닫힌다); 더 깊은
  // 자손은 살아 있는 트리를 봐야 알 수 있어 제어 평면이 판정하고, 거절은 컨트롤이 그대로 띄운다.
  const childIds = new Set(children.map((child) => child.id))
  const parentOptions = siblings
    .filter((s) => s.id !== current.id && !childIds.has(s.id))
    .map((s) => ({ id: s.id, identifier: s.identifier, title: s.title, status: s.status }))
  // 이력·담당자·해결 기록이 같은 이름·같은 얼굴을 쓰도록 subject → 프로필을 한 번만 만든다.
  const actors = memberDirectoryOf(members)
  const displayName = (subject: string): string => memberNameOf(actors, subject)

  const at = siblings.findIndex((s) => s.id === current.id)
  const previous = at > 0 ? siblings[at - 1] : undefined
  const next = at >= 0 ? siblings[at + 1] : undefined

  const linked = new Set(evaluation.linked)
  const entries: IssueEvaluationEntry[] = evaluation.scorecards.map((s) => {
    const metric = s.summary?.find((m) => m.passRate != null) ?? s.summary?.[0] // fallback for pre-headline rows
    return {
      id: s.id,
      dataset: s.dataset,
      harness: s.harness,
      passRate: s.headlinePassRate ?? metric?.passRate ?? null,
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
  // 속성 열이 보여주는 링크 = 이슈를 검증하는 능력(하네스·데이터셋·저지)뿐이고, 종류마다 자기 줄을 갖는다 —
  // 상태·프로젝트·라벨과 같은 속성이라서 같은 격자에서 고른다. 스코어카드 링크는 능력이 아니라 증거이고
  // 아래 "평가 이력"이 이미 고정 배지로 보여주므로 여기 서지 않는다.
  const capabilityOptions: Record<IssueCapabilityLinkType, CapabilityOption[]> = {
    harness: harnesses.map((h) => ({
      id: h.id,
      ...(h.subtitle !== undefined ? { hint: h.subtitle } : {}),
    })),
    dataset: datasets.map((d) => ({
      id: d.id,
      ...(d.description !== undefined ? { hint: d.description } : {}),
    })),
    judge: judges.map((j) => ({ id: j.id })),
  }

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
            {parent && (
              <>
                <ChevronRight className="size-3 shrink-0 text-faint" />
                {/* 하위 이슈는 부모를 경로에 이고 다닌다 — 이 이슈가 무엇에서 쪼개져 나왔는지가 곧 위치다.
                    식별자만으로는 `ENG-11` 이 무엇인지 알 수 없어 위치를 말해 주지 못했다 — 제목까지 함께
                    이고 다녀야 "무엇에서 쪼개져 나왔나"에 답이 된다(좁아지면 제목부터 줄어든다). */}
                <Link
                  href={issueHref(workspace, parent.identifier, parent.title)}
                  title={`${parent.identifier} · ${parent.title}`}
                  className="flex min-w-0 items-center gap-1 text-muted-foreground transition-colors hover:text-foreground"
                >
                  <span className="shrink-0 font-mono text-[12px]">{parent.identifier}</span>
                  <span className="truncate">{parent.title}</span>
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
                  position: state.position,
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
            {/* 상위 이슈 — 이 이슈가 무엇에서 쪼개져 나왔는지. 브레드크럼에도 있지만 그건 위치이지 속성이
                아니라, 하위 이슈인 것을 알아채고 붙였다 뗄 수 있는 자리는 여기다(예전에는 그 자리가 화면
                어디에도 없어서 에이전트만 부모를 바꿀 수 있었다). 세울 수 있는 이슈가 하나도 없으면
                빈 행을 내지 않는다(빈 섹션 숨김). */}
            {(parent !== undefined || (canWrite && parentOptions.length > 0)) && (
              <PropertyRow label={t('fieldParent')}>
                <IssueParentControl
                  workspace={workspace}
                  id={current.id}
                  parent={
                    parent
                      ? {
                          id: parent.id,
                          identifier: parent.identifier,
                          title: parent.title,
                          status: parent.status,
                        }
                      : undefined
                  }
                  options={parentOptions}
                  canWrite={canWrite}
                />
              </PropertyRow>
            )}
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
            {/* 프로젝트 체크포인트 — 프로젝트 바로 아래 줄이다. 마일스톤은 프로젝트 안에서만 의미가 있어
                (제어 평면이 "이 이슈 프로젝트의 것인가"를 판정한다) 프로젝트가 없거나 체크포인트를 하나도
                두지 않은 프로젝트에서는 줄을 내지 않는다(빈 섹션 숨김). 프로젝트 상세는 체크포인트별 이슈
                수를 세는데, 이슈를 체크포인트에 걸 자리가 화면 어디에도 없어 그 수는 늘 0이었다. */}
            {(milestone !== undefined || (canWrite && milestoneOptions.length > 0)) && (
              <PropertyRow label={t('fieldMilestone')}>
                <IssueMilestoneControl
                  id={current.id}
                  milestone={milestone}
                  milestones={milestoneOptions}
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
            {/* 이 이슈를 검증하는 능력 — 하네스·데이터셋·저지가 각자 한 줄이다. 예전에는 속성 격자 밖의 작은
                폼이었고 id 를 손으로 적어야 했다: 레지스트리에 무엇이 있는지 아는 사람만 쓸 수 있었고, 오타는
                아무 데도 가리키지 않는 링크가 됐다(링크는 검증되지 않는 포인터다). 이제 등록된 것 중에서 고른다.
                고를 것도 걸린 것도 없는 종류는 줄을 내지 않는다(빈 섹션 숨김). */}
            {ISSUE_CAPABILITY_LINK_TYPES.map((kind) => {
              const linked = current.links.filter((link) => link.type === kind)
              const options = capabilityOptions[kind]
              if (linked.length === 0 && !(canWrite && options.length > 0)) return null
              return (
                <PropertyRow key={kind} label={tracker(`linkType.${kind}`)}>
                  <IssueCapabilityControl
                    workspace={workspace}
                    issueId={current.id}
                    type={kind}
                    links={linked}
                    options={options}
                    canWrite={canWrite}
                  />
                </PropertyRow>
              )
            })}
            {/* 프로덕트 타임라인 — 이 이슈가 속한 프로덕트와, 막고 있는 릴리즈. 릴리즈 게이트는 이 링크의
                역방향 질의로 열린 이슈를 세므로, 여기서 거는 한 번이 곧 "이 릴리즈는 이 이슈가 끝나야 나간다"다.
                고를 것도 걸린 것도 없는 종류는 줄을 내지 않는다(빈 섹션 숨김). */}
            {(['product', 'release'] as const).map((kind) => {
              const linked = current.links.filter((link) => link.type === kind)
              const options =
                kind === 'product'
                  ? timelineProducts.map((p) => ({ id: p.id, label: p.name }))
                  : releases.map((r) => {
                      const owner = timelineProducts.find((p) => p.id === r.productId)
                      return {
                        id: r.id,
                        label: owner !== undefined ? `${owner.name} · ${r.name}` : r.name,
                        ...(r.targetDate !== undefined ? { hint: r.targetDate } : {}),
                      }
                    })
              if (linked.length === 0 && !(canWrite && options.length > 0)) return null
              return (
                <PropertyRow key={kind} label={tracker(`linkType.${kind}`)}>
                  <IssueTimelineLinkControl
                    workspace={workspace}
                    issueId={current.id}
                    type={kind}
                    links={linked}
                    options={options}
                    canWrite={canWrite}
                  />
                </PropertyRow>
              )
            })}
            {/* 언급 — 이 이슈가 가리키는 다른 이슈들. 능력 세 줄이 "무엇으로 검증하는가"라는 고정된 질문인
                것과 달리 이건 자유로운 교차참조라, 종류를 파라미터로 받는 한 줄이 맡는다(지금은 이슈만). */}
            {ISSUE_MENTION_LINK_TYPES.map((kind) => {
              if (mentions.length === 0 && !canWrite) return null
              return (
                <PropertyRow key={kind} label={tracker(`linkType.${kind}`)}>
                  <IssueMentionControl
                    workspace={workspace}
                    issueId={current.id}
                    type={kind}
                    mentions={mentions}
                    canWrite={canWrite}
                  />
                </PropertyRow>
              )
            })}
            {/* 반대 방향 — 나를 언급한 이슈들. 남의 레코드에 있는 링크라서 여기서는 읽기만 한다(GitHub 이
                교차참조를 타임라인에 남기고 그 자리에서 지우게 하지 않는 것과 같다). 없으면 줄이 없다. */}
            {mentionedBy.length > 0 && (
              <PropertyRow label={t('fieldMentionedBy')}>
                <span className="inline-flex flex-wrap items-center gap-1">
                  {mentionedBy.map((issue) => (
                    <Link
                      key={issue.id}
                      href={issueHref(workspace, issue.identifier, issue.title)}
                      title={`${issue.identifier} · ${issue.title}`}
                      className="inline-flex max-w-full items-center gap-1 rounded bg-secondary py-0.5 px-1.5 text-[11px] text-secondary-foreground ring-1 ring-inset ring-border transition-colors hover:text-foreground"
                    >
                      <IssueStatusIcon status={issue.status} />
                      <span className="shrink-0 font-mono">{issue.identifier}</span>
                      <span className="min-w-0 truncate">{issue.title}</span>
                    </Link>
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
        </aside>

        {/* ③ 이슈의 맥락과 증거, 그리고 논의.
            본문 열 전체를 확대 뷰어로 감싼다 — 설명·GitHub 코멘트·논의에 실린 그림이 한 묶음의 좌우 이동이
            되어야, 스크린샷을 비교하려고 이슈를 떠날 이유가 없어진다. */}
        <MediaLightbox className="min-w-0 space-y-7 @3xl:col-start-1 @3xl:row-start-1">
          {/* 설명은 제목 바로 아래에서 시작한다(섹션 제목 없이) — 이 화면의 본문은 이슈 그 자체다.
              An imported GitHub issue's body IS markdown — render it as such (GFM), never as flat text. */}
          {/* imageProxy: 본문의 GitHub 첨부 이미지는 브라우저가 직접 못 받아온다(GHE·비공개 리포는 리포와 같은
              인증 뒤에 있고 크로스사이트 img 요청에는 그 세션이 안 실린다) — 우리 라우트를 거쳐 서버가 받아온다. */}
          {/* mermaid: an issue body is where a design gets argued, and the drawing IS the argument — a
              ```mermaid fence renders as the diagram (GitHub does the same). Safe to opt in here because
              this body is finished text, not a stream: nothing re-parses it per chunk. */}
          {current.description && (
            <Markdown
              content={current.description}
              mermaid
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
