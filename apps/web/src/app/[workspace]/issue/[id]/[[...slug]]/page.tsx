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

// The window of sibling issues up/down navigation sweeps. It re-reads the list screen's default order (most recent
// activity) scoped to the team, so it is "the next issue in the list you were looking at". An issue pushed out of the window leaves the arrows disabled — better than pulling the whole team.
const SIBLING_WINDOW = 200

// How many mentions one issue is worth hand-linking — in either direction. An issue with more than this did not get
// mentions, it got a LIST, and the attribute column is not where a list is drawn.
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

// Up/down movement between sibling issues — pinned to the right end of the header. With nowhere to go it stays
// DISABLED rather than disappearing, so the buttons do not shift position from issue to issue.
function SiblingLink({
  workspace,
  issue,
  direction,
  label,
}: {
  workspace: string
  // A neighbour is the list's summary shape — the arrows need only the identifier and the title, so there is no reason to read a whole record.
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
// The layout is Linear's issue view. ① The top breadcrumb (issue → team → identifier) answers "where does this issue
// live", with the actions on this issue beside it (copy link, ⋯) and sibling up/down at the right end.
// ② The title stands alone, large. ③ The body (description, evidence, discussion) is the left column and ④ every
// attribute is one right column. Not mixing where you READ with where you CHANGE is the whole of this layout.
export default async function IssueDetailPage({
  params,
  searchParams,
}: {
  // The `id` segment is a REF — the slug (`ENG-12`) is canonical, and the control plane also accepts a uuid link copied long ago.
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
  // Normalize the address — a link that arrived as a uuid, or was pasted lower-cased, becomes the name the team stamped.
  // A `?comment=` carried by a notification is passed straight through (skip the redirect and the mentioned comment is unreachable).
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
    // The projects this issue could belong to — every one in the workspace.
    controlPlane
      .listProjects(ctx, {})
      .then((r) => projectsSchema.parse(r))
      .catch((): Project[] => []),
    controlPlane
      .listMembers(ctx)
      .then((r) => membersSchema.parse(r))
      .catch((): Member[] => []),
    // The workspace board — the status dropdown uses the names pinned there.
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
    // Sub-issues — the list projection is enough (draw only what a row draws).
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
    // What can be picked as a capability that verifies this issue — every harness, dataset and judge registered in the workspace.
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
    // The issues that MENTION this one — a link is stored only on the mentioning side, so the mentioned side can learn about it
    // only by asking in this direction (the same query a harness detail runs to find the issues watching it).
    controlPlane
      .listIssues(ctx, { linkType: 'issue', linkId: current.id, limit: MENTION_WINDOW })
      .then((r) => issuePageSchema.parse(r).items)
      .catch((): IssueSummary[] => []),
    // The product timeline's two rows (product, release) — links store UUIDs, so a list is needed to resolve them into names,
    // and the release gate counts these links, which makes picking one the gate's own grounds.
    controlPlane
      .listProducts(ctx)
      .then((r) => productsSchema.parse(r))
      .catch((): TimelineProduct[] => []),
    controlPlane
      .listReleases(ctx)
      .then((r) => releaseSchema.array().parse(r))
      .catch((): Release[] => []),
  ])

  // The issues this one mentions — the link holds only a UUID and says nothing by itself. Drawing it needs the identifier,
  // title and status, so they are read one at a time (mentions are hand-made, so there are few, and an unreadable one is
  // dropped quietly: drawing a deleted or invisible issue as a bare UUID helps nobody).
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
  // Attaching a file to the description is a WRITE to the workspace filesystem — the same grade as writing the issue (member+),
  // and it is judged with that permission.
  const canAttach = can(principal?.roles ?? [], 'files:write')
  // A closed issue's past due date is not a warning — a red badge on work that is already finished is noise.
  const dueOverdue =
    current.status !== 'done' &&
    current.status !== 'cancelled' &&
    isPastDue(current.dueDate, timeZone)
  const project = current.projectId ? projects.find((p) => p.id === current.projectId) : undefined
  // A checkpoint lives only inside a project — the only ones selectable are those of the project this issue is in (the control
  // plane judges it that way), and they already arrive with the project read (no extra read at all). The order must match what
  // the project detail draws — the same list must not appear in a different order on two screens.
  const milestoneOptions = [...(project?.milestones ?? [])]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((m) => ({ id: m.id, name: m.name, ...(m.targetDate ? { targetDate: m.targetDate } : {}) }))
  const milestone = current.milestoneId
    ? milestoneOptions.find((m) => m.id === current.milestoneId)
    : undefined
  // The issues that could be its parent — the workspace's issues. It reuses the window sibling navigation already read, so no
  // read is added. Itself and its own sub-issues are excluded (going under your own descendant closes a cycle); deeper
  // descendants need the live tree to see, so the control plane judges those and the control surfaces its refusal verbatim.
  const childIds = new Set(children.map((child) => child.id))
  const parentOptions = siblings
    .filter((s) => s.id !== current.id && !childIds.has(s.id))
    .map((s) => ({ id: s.id, identifier: s.identifier, title: s.title, status: s.status }))
  // Build subject → profile ONCE so history, assignee and the resolution record use the same name and the same face.
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
  // Who can be assigned — only people who are workspace members NOW. `actors` knows the names of people who have left too
  // (past issues' assignees and history have to be drawn), but this is what can be assigned afresh.
  const assignableMembers = members.map((m) => ({
    subject: m.subject,
    name: actors[m.subject]?.name ?? m.subject,
    ...(m.avatarUrl !== undefined ? { avatarUrl: m.avatarUrl } : {}),
  }))
  // The links the attribute column shows are ONLY the capabilities that verify the issue (harness, dataset, judge), each with
  // its own row — they are attributes like status, project and labels, so they are picked in the same grid. A scorecard link is
  // evidence rather than a capability, and "evaluation history" below already shows it as a fixed badge, so it does not stand here.
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
      {/* ① Location and actions on the left, sibling movement at the right end — these two groups are never mixed. */}
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
                {/* A sub-issue carries its parent in the path — what it was split OUT of is its location.
                    An identifier alone could not say what `ENG-11` is, so it could not state a location — the title has to travel
                    with it for "what was this split out of" to have an answer (the title shrinks first when space runs out). */}
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
            {/* The name people use — here, at the same place as the address, rather than in front of the title. */}
            <span className="shrink-0 font-mono text-[12px] font-[510] text-foreground">
              {current.identifier}
            </span>
          </nav>
          <CopyLinkButton label={t('copyLink')} message={t('linkCopied')} className="ml-0.5" />
          {/* Hand this issue to an agent conversation as context — the same entry as every other detail, except this header is an
              icon row, so the caption is folded away. The reference key is the identifier (ENG-12), not the UUID — the same shape
              the @-picker produces, so the same issue is never attached twice, and the name people use survives into the context
              header the agent reads. `fresh`: start in a NEW conversation, like entering a skill edit — this conversation is about
              THIS issue, not about whatever thread was open, and mission framing only appears on an empty screen. */}
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

      {/* ② The one thing that must land largest on an issue page. Free text, so it wraps rather than truncates. */}
      <h1 className="break-words pt-5 text-[22px] font-[560] leading-[1.3] tracking-[-0.01em] text-foreground">
        {current.title}
      </h1>

      <div className="grid gap-x-8 gap-y-6 pt-5 @3xl:grid-cols-[minmax(0,1fr)_17rem]">
        {/* ④ Attributes are collected into one column. When narrow it folds directly under the title (so it is read BEFORE the
            body), which is why it carries a bottom border there — so the attribute group and the body do not blur into one. Not needed in two columns. */}
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
            {/* The assignee is set and cleared right in this column — previously a single name line appeared only when someone was
                already assigned, and with an issue open there was nowhere on the detail screen to assign a person (you had to go
                back to the list row). For someone who can write, the row is drawn even when empty — only a read-only view hides it. */}
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
            {/* The parent issue — what this was split out of. It is in the breadcrumb too, but that is LOCATION, not an attribute,
                and this is the place to notice you are a sub-issue and attach or detach (previously that place did not exist
                anywhere on screen, so only an agent could change a parent). With no issue available to set as parent, no empty
                row is drawn (empty-section hiding). */}
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
            {/* The project is added and removed right in this column too — a single link line visible only when already attached
                left nowhere on screen to answer "which project does this issue go in" (it lived inside the edit dialog only).
                In a workspace with no project to pick, no empty row is drawn (empty-section hiding). */}
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
            {/* The project checkpoint — the row directly under the project. A milestone means something only inside a project (the
                control plane judges "is this one of this issue's project's"), so no row is drawn with no project, or with a project
                that set no checkpoints (empty-section hiding). The project detail counts issues per checkpoint, and with nowhere on
                screen to attach an issue to one, that count was always zero. */}
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
                {/* A due date takes colour only once it has PASSED — colour a date that has not and the warning becomes the background. */}
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
            {/* Labels are attached and detached right in this column — for someone who can write, the row is drawn even when empty
                (with nowhere on screen to attach one it becomes "an attribute you cannot edit"). Only a read-only view hides it. */}
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
            {/* The capabilities that verify this issue — harness, dataset and judge each get a row. This used to be a small form
                outside the attribute grid where the id was typed by hand: only someone who knew what the registry held could use it,
                and a typo became a link pointing nowhere (a link is an UNVERIFIED pointer). Now they are picked from what is
                registered. A kind with nothing to pick and nothing attached draws no row (empty-section hiding). */}
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
            {/* The product timeline — the product this issue belongs to, and the release it blocks. The release gate counts open
                issues by querying this link in reverse, so attaching one here IS "this release does not ship until this issue is done".
                A kind with nothing to pick and nothing attached draws no row (empty-section hiding). */}
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
            {/* Mentions — the other issues this one points at. Where the three capability rows are a FIXED question ("what verifies
                this"), this is a free cross-reference, so one row takes the kind as a parameter (today: issues only). */}
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
            {/* The reverse direction — the issues that mention me. The link lives on somebody else's record, so this is read-only
                here (the same reason GitHub leaves a cross-reference on the timeline and does not let you delete it from there). None: no row. */}
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
            {/* `github` is attached by IMPORT only (there is no path for linking an existing issue later) — so this row says where
                this issue came FROM rather than saying "GitHub". The full address goes in the title so a GHE host can be checked
                too. */}
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

        {/* ③ The issue's context and evidence, and the discussion.
            The whole body column is wrapped in the zoom viewer — a picture in the description, a GitHub comment and the discussion
            have to be ONE left/right group, so comparing screenshots is never a reason to leave the issue. */}
        <MediaLightbox className="min-w-0 space-y-7 @3xl:col-start-1 @3xl:row-start-1">
          {/* The description starts directly under the title (with no section heading) — the body of this screen IS the issue.
              An imported GitHub issue's body IS markdown — render it as such (GFM), never as flat text. */}
          {/* imageProxy: the browser cannot fetch the GitHub attachment images in the body itself (GHE and private repos sit behind
              the same auth as the repo, and a cross-site img request carries no such session) — the server fetches them through our route. */}
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

          {/* Sub-issues — an empty section is not drawn (house rule). Progress is COUNTED here rather than stored: the issue list is
              already in hand so the arithmetic is free, and stored it would be a cache to invalidate every time a child moves. */}
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
