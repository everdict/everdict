import { ChevronLeft, Download } from 'lucide-react'
import { getTimeZone, getTranslations } from 'next-intl/server'

import { MentionInChatButton, OpenConversationButton } from '@/widgets/infra-panel'
import { LiveLogs } from '@/widgets/live-logs'
import { LiveTrace } from '@/widgets/live-trace'
import { ReplayPlayer } from '@/widgets/replay-player'
import { RunPlacement } from '@/widgets/run-placement'
import { RunTopology } from '@/widgets/run-topology'
import { RunFileWorkbench } from '@/widgets/run-workbench'
import { LiveScreen, LiveTerminal } from '@/widgets/sandbox-terminal'
import { asSingleSegment, TrajectoryView, type TrajectorySegment } from '@/features/browse-traces'
import { CommentsSection } from '@/features/discuss'
import { membersSchema } from '@/entities/member'
import {
  RUN_KIND_META,
  runCaseSpecSchema,
  runKindOf,
  RunLiveStreamProvider,
  RunOutcome,
  runSchema,
  trajectoryResponseSchema,
  type Run,
  type RunCaseSpec,
} from '@/entities/run'
import { traceEventSchema, type TraceEvent } from '@/entities/trace'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { fmtSubject, fmtTokens, fmtUsd } from '@/shared/lib/format'
import { Badge } from '@/shared/ui/badge'
import { Callout } from '@/shared/ui/callout'
import { Card } from '@/shared/ui/card'
import { RuntimeChip } from '@/shared/ui/chip'
import { Link } from '@/shared/ui/link'
import { CancelRunButton } from '@/features/cancel-run'
import { PageHeader } from '@/shared/ui/page-header'
import { SectionHeader } from '@/shared/ui/section-header'
import { StatusPill } from '@/shared/ui/status-pill'

export const dynamic = 'force-dynamic'

// os-use screenshot src: inline base64 (dev) → data URL, else object storage URL (offloaded). undefined if neither.
function osUseShotSrc(snapshot?: {
  screenshot?: string
  screenshotRef?: string
}): string | undefined {
  if (snapshot?.screenshot) return `data:image/png;base64,${snapshot.screenshot}`
  if (snapshot?.screenshotRef && /^https?:\/\//.test(snapshot.screenshotRef))
    return snapshot.screenshotRef
  return undefined
}

// Whether a snapshot actually has anything to show — otherwise the detail hides the snapshot section entirely (the empty-section rule). A prompt run (environment-less QA)
// usually has an empty final answer (its main signal is the trace), so it used to render raw `{kind:"prompt",output:""}` JSON and read as "an empty snapshot every time".
// This gate removes that. docs/web.md — an empty section is hidden whole (no "none" placeholder).
function snapshotHasContent(s: NonNullable<Run['result']>['snapshot']): boolean {
  if (!s) return false
  if (osUseShotSrc(s)) return true // any kind with a captured screen has something to show
  switch (s.kind) {
    case 'prompt':
      return Boolean(s.output?.trim())
    case 'os-use':
      return Boolean(s.windows?.length)
    case 'repo':
      return Boolean(s.diff?.trim() || s.changedFiles?.length)
    case 'browser':
      return Boolean(s.url || s.dom || s.domRef)
    default:
      return Boolean(s.url || s.dom || s.output?.trim())
  }
}

// The evidence view (TrajectoryView, shared with Settings › Observability) reads the CONTRACT-shaped trace union,
// while this page parses the run record loosely on purpose (`entities/run`'s passthrough consumer view, so a
// server-side trace-kind addition never rejects the whole run). Re-parse the same array through the strict lens,
// PER EVENT: an event kind this build doesn't model yet drops out of the evidence view instead of blanking the
// page. No extra fetch — same bytes, second lens.
function toEvidence(events: unknown[]): TraceEvent[] {
  const evidence: TraceEvent[] = []
  for (const event of events) {
    const parsed = traceEventSchema.safeParse(event)
    if (parsed.success) evidence.push(parsed.data)
  }
  return evidence
}

// Source (the activity view's source axis) → the shared human label (reused from the runs-table). Unset = direct API.
const SOURCE_KEY: Record<string, string> = {
  web: 'sourceWeb',
  mcp: 'sourceMcp',
  api: 'sourceApi',
  scorecard: 'sourceScorecard',
  schedule: 'sourceSchedule',
  'front-door': 'sourceFrontDoor',
}

// One labeled cell of the meta card (dt/dd). Rich cells (runtime chip, scorecard link) pass `children`; `Prop` is the
// plain-text convenience over it (harness/case/source/run-by/created/updated).
function MetaItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-[510] uppercase tracking-wide text-faint">{label}</dt>
      <dd className="mt-1">{children}</dd>
    </div>
  )
}

function Prop({ label, value }: { label: string; value: string }) {
  return (
    <MetaItem label={label}>
      <span className="block truncate font-mono text-[13px] text-foreground">{value}</span>
    </MetaItem>
  )
}

// One economics stat of the usage card (cost / tokens / calls) — a single run's own cost, which a scorecard only
// aggregates. `usage` is derived from the trace on read (usageFromTrace), so it needs no separate fetch.
function UsageStat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div title={hint}>
      <div className="text-[10.5px] font-[560] uppercase tracking-wide text-faint">{label}</div>
      <div className="mt-0.5 font-mono text-[15px] font-[560] tabular-nums">{value}</div>
    </div>
  )
}

function BackLink({ workspace, label }: { workspace: string; label: string }) {
  return (
    <Link
      href={`/${workspace}/runs`}
      className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
    >
      <ChevronLeft className="size-3.5" />
      {label}
    </Link>
  )
}

// ── HOW MUCH OF A TRACE ONE SCREEN READS (a five-hour agent's is not a page) ─────────────────────────
//
// The sealed read has taken `after`/`limit` since the split-plane store landed and this page asked for
// neither, so a long agent run downloaded every event it had ever emitted, parsed each through the trace
// union, and rendered the lot — the read, the parse and the DOM all scaling with the run's DURATION.
//
// 500 is chosen against what a reader can actually use rather than what the wire can carry: it is more than
// any screenful, and small enough that the parse stays imperceptible on a slow machine. A truncated view says
// so and pages forward instead of pretending it is whole — a silently-cut trace is the worst direction for
// evidence to fail in.
//
// ⚠️ AND "IS THERE MORE" IS THE STORE'S ANSWER, NOT ARITHMETIC. This first read that question from
// `from + shown < meta.eventCount`, which is a different question: `meta.eventCount` sums EVERY sealed plane
// and a page serves ONE, so a service-topology run (an execution plane plus a plane per service emitter)
// overstated its total and kept offering a next page after the plane it was paging had run out. `nextAfter`
// was on the wire the whole time and the web schema dropped it — a predicate written twice, already diverged
// (rule `protocol` L3).
const TRACE_PAGE = 500

export default async function RunDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; id: string }>
  searchParams: Promise<{ traceAfter?: string }>
}) {
  const { workspace, id } = await params
  const { traceAfter } = await searchParams
  const traceFrom = traceAfter !== undefined && /^\d+$/.test(traceAfter) ? Number(traceAfter) : 0
  const t = await getTranslations('runsPage')
  const timeZone = await getTimeZone()
  const ctx = await authContext()

  let run: Run | undefined
  let error: string | undefined
  // caseSpec reads the same response once more through a narrower lens (see the runCaseSpecSchema comment — mirroring the whole
  // EvalCase breaks the drift guard). A failure still renders the detail: only the request section is missing.
  let caseSpec: RunCaseSpec | undefined
  try {
    const raw = await controlPlane.getRun(ctx, id)
    run = runSchema.parse(raw)
    caseSpec = runCaseSpecSchema.safeParse(raw).data?.caseSpec
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  if (!run) {
    return (
      <div className="space-y-5">
        <BackLink workspace={workspace} label={t('title')} />
        <PageHeader title={t('runLabel')} />
        <Callout tone="danger">{t('runLoadError', { error: error ?? '' })}</Callout>
      </div>
    )
  }

  const snapshot = run.result?.snapshot
  const usage = run.usage

  // Trace: the row embed first (legacy eval runs), else the OWNED trajectory store (N1 look-inward) — the
  // sealed evidence is how agent/sandbox/OTLP runs render at all (they never carry a result embed).
  // Soft-fail: an unsealed run simply has no trace section yet.
  //
  // `segments` is what the evidence view reads: one plane per EMITTER (the execution's own stream plus each
  // service that pushed its own OTel spans into this run). The run-scoped read carries them, so one fetch
  // serves both — and a row embed is a single plane the page builds with no fetch at all.
  let trace = run.result?.trace ?? []
  let trajectorySource: string | undefined
  let segments: TrajectorySegment[] = []
  // What this screen is actually showing, when the sealed trace is longer than one page. `nextAfter` is the
  // STORE's answer to "is there more, and from where" — never re-derived from a count, because
  // `meta.eventCount` sums every plane while this page serves one.
  let traceWindow: { from: number; shown: number; total: number; nextAfter?: number } | undefined
  if (trace.length === 0) {
    try {
      const runScoped = trajectoryResponseSchema.parse(
        await controlPlane.getRunTrajectory(ctx, id, { after: traceFrom, limit: TRACE_PAGE })
      )
      trace = runScoped.events
      trajectorySource = runScoped.meta.source
      // The total belongs to the plane being paged, not to the trajectory: a service-topology run seals a
      // plane per emitter and `meta.eventCount` is their SUM, so quoting it here would tell a reader their
      // window is a fifth of what it is. Falls back to the trajectory's count when nothing names a plane —
      // which is every single-plane run, i.e. almost all of them.
      const pagedPlane = runScoped.segments.find((segment) => segment.execution === true)
      traceWindow = {
        from: traceFrom,
        shown: runScoped.events.length,
        total: pagedPlane?.eventCount ?? runScoped.meta.eventCount,
        ...(runScoped.nextAfter !== undefined ? { nextAfter: runScoped.nextAfter } : {}),
      }
      segments =
        runScoped.segments.length > 0
          ? runScoped.segments.map((segment) => ({
              ...segment,
              // The execution segment omits its events on the wire (never shipped twice) — rehydrate it here.
              events: toEvidence(segment.events ?? runScoped.events),
            }))
          : // Sealed records that do not send segments yet (anything sealed before multi-plane grading — every live agent turn
            // today is one of these) have the execution's own stream as the whole trajectory. Without this fallback the evidence
            // section disappears entirely despite there being events. The browse-trajectories action carries the same fallback.
            asSingleSegment(toEvidence(runScoped.events), 'run')
    } catch {
      // 404 = nothing sealed (and no embed) — the page just omits the trace sections.
    }
  } else {
    segments = asSingleSegment(toEvidence(trace), 'run', run.result?.traceT0)
  }

  // Replay is available for any settled run that produced an agent trace (EVERY harness does) or a recording —
  // not only ones with environment frames. The agent trace is the universal replay spine; frames are a per-kind
  // addition. A still-RUNNING run mounts the player too: live is "a replay that has not finished", so it polls the recording tail plus the
  // live trajectory and scrubs into the past while still in progress (the player self-nulls with no data). docs/architecture/replay.md.
  const isTerminal = run.status === 'succeeded' || run.status === 'failed'
  const hasReplay = isTerminal && (trace.length > 0 || run.result?.recordingRef != null)
  // A sandbox (browser) session can have had its CDP environment plane recorded during the session even when the record carries no
  // trace/recordingRef — mounting the player after it closes lets it find the sealed recording itself, and self-null when there is none.
  const mountsReplay = hasReplay || !isTerminal || runKindOf(run) === 'sandbox'

  // Source label — reuse the runs-table's shared source vocabulary (web/mcp/api/scorecard/schedule/front-door).
  const tTable = await getTranslations('runsTable')
  const sourceKey = run.trigger ? SOURCE_KEY[run.trigger] : undefined
  const sourceText = run.trigger
    ? sourceKey
      ? tTable(sourceKey)
      : run.trigger
    : tTable('sourceDirect')

  // Run-by name (members join) — supplementary, so the detail still renders if it fails. Name is profile name > email
  // local part > shortened subject. Machine-fired runs (createdBy unset) skip the lookup and hide the cell.
  let authorName: string | undefined
  if (run.createdBy) {
    const createdBy = run.createdBy
    const members = await controlPlane
      .listMembers(ctx)
      .then((r) => membersSchema.parse(r))
      .catch(() => [])
    const m = members.find((x) => x.subject === createdBy)
    authorName = m?.name ?? m?.email?.split('@')[0] ?? fmtSubject(createdBy)
  }

  // Runtime this run was placed on — a registered runtime links to its detail; a self-hosted runner (self / self:<id>)
  // shows a generic label with no link (multi-tenant: it may be another member's personal device, no screen to open).
  const runtime = run.runtime
  const runtimeIsSelfHosted = runtime === 'self' || (runtime?.startsWith('self:') ?? false)

  // The meta card's two axes share their columns and mean different things per kind — the domain's factory fills them that way (an agent
  // spec or an environment capability goes in the harness column, and what woke it or its image goes in caseId). Pinning the labels to
  // harness/case leaves the lie that a chat turn reads as "case chat" and a sandbox as "case ubuntu:24.04".
  const subjectLabel =
    run.kind === 'agent' ? 'agent' : run.kind === 'sandbox' ? 'environment' : 'harness'
  const objectLabel = run.kind === 'agent' ? 'cause' : run.kind === 'sandbox' ? 'image' : 'case'

  // The live panels open only the channels the run DECLARED. This used to guess "probably container-based" from the kind here, which
  // makes the same promise to a run that executed in the cluster and one that executed on somebody's laptop (self-hosted) and then
  // delivers something else. The judgement now lives in one place in the control plane (domain's attachChannelsFor) — and an old run
  // that declared nothing is filled by the same rule on read — so here it is only READ.
  const attach = run.attach ?? []
  const showLiveLogs = attach.includes('logs')
  const showTerminal = attach.includes('exec') || attach.includes('terminal')
  // The file workbench opens on the terminal channel (managed exec) or on the self-hosted lane — self:* cannot exec, but the runner's
  // in-case serving loop answers parked fs reads (runnerCaseFs). With no repo in the sandbox the widget self-nulls.
  const showFileWorkbench = showTerminal || (run.runtime?.startsWith('self:') ?? false)

  // The run that CAUSED this run — an edge of the demand graph (an execution submitted by an agent is the common one). When the parent
  // group is a scorecard the meta card already links it, so only other groups (a playground session's case) are surfaced here.
  const causedByRunId = run.origin?.causedByRunId
  const sessionRunId =
    run.group?.role === 'case' && !run.parentScorecardId ? run.group.id : undefined

  return (
    // @container: the sections below size off THIS column's width, not the viewport's — the infra panel splits
    // the page, so a viewport breakpoint would keep promising space this column no longer has.
    <div className="@container space-y-7">
      <div className="space-y-3">
        <BackLink workspace={workspace} label={t('title')} />
        <PageHeader
          title={<span className="font-mono">run {run.id.slice(0, 8)}</span>}
          description={t('runDescription', {
            harness: `${run.harness.id}@${run.harness.version}`,
            caseId: run.caseId,
          })}
          actions={
            <div className="flex items-center gap-2">
              <MentionInChatButton
                reference={{ type: 'run', id: run.id, label: run.id.slice(0, 8) }}
                mission="runAnalyze"
              />
              {/* The execution family — only a non-eval run wears the badge (the same rule as the activity console's rows). Without it,
                  an agent turn and a sandbox session read like a harness eval: the columns are the same and the meaning is not. */}
              {runKindOf(run) !== 'eval' && (
                <Badge tone="info">{tTable(RUN_KIND_META[runKindOf(run)].labelKey)}</Badge>
              )}
              {/* A replayable run gets a "replay" badge → jumps to the #replay section below (discoverability). An agent trace alone
                  replays (harness-independent), so it is surfaced from the trace even with no recordingRef. */}
              {hasReplay && (
                <a href="#replay" className="no-underline">
                  <Badge tone="info">{t('replay')}</Badge>
                </a>
              )}
              {/* On a session run `running` means "alive" rather than "in progress", and `succeeded` means "reclaimed" — without that fact
                  standing beside the status, an ops view reads a healthy session as a stalled batch. */}
              {run.lifetime === 'session' && (
                <Badge tone="neutral">
                  {run.status === 'running' ? t('sessionAlive') : t('sessionClosed')}
                </Badge>
              )}
              <StatusPill status={run.status} />
              {/* Only while it can still be stopped — a settled run's button is a control that answers
                  409 and nothing else, which teaches people the page lies. */}
              <CancelRunButton id={run.id} status={run.status} />
            </div>
          }
        />
      </div>

      <Card className="grid grid-cols-2 gap-4 p-4 @2xl:grid-cols-4">
        <Prop label={subjectLabel} value={`${run.harness.id}@${run.harness.version}`} />
        <Prop label={objectLabel} value={run.caseId} />
        {/* Runtime (where it ran) — registered runtime links out; a self-hosted runner shows a label only. Hidden if unset (legacy / default backend). */}
        {runtime && (
          <MetaItem label={t('metaRuntime')}>
            {runtimeIsSelfHosted ? (
              <RuntimeChip label={t('runtimeSelfHosted')} />
            ) : (
              <Link
                href={`/${workspace}/runtime/${encodeURIComponent(runtime)}`}
                className="rounded-sm hover:underline"
                title={t('runtimeDetailTitle')}
              >
                <RuntimeChip label={runtime} />
              </Link>
            )}
          </MetaItem>
        )}
        {/* Source (why this run happened) + run-by (who) — the activity view's provenance axes, folded into the meta card. */}
        <Prop label={t('metaSource')} value={sourceText} />
        {authorName && <Prop label={t('metaRunBy')} value={authorName} />}
        <Prop
          label="created"
          value={new Date(run.createdAt).toLocaleString(undefined, { timeZone })}
        />
        <Prop
          label="updated"
          value={new Date(run.updatedAt).toLocaleString(undefined, { timeZone })}
        />
        {/* Batch child run → back-link to the scorecard it belongs to (standalone runs have no parent, so hidden). */}
        {run.parentScorecardId && (
          <MetaItem label={t('metaScorecard')}>
            <Link
              href={`/${workspace}/scorecard/${encodeURIComponent(run.parentScorecardId)}`}
              className="inline-flex items-center gap-1 font-mono text-[13px] text-link transition-colors hover:text-foreground"
            >
              {run.parentScorecardId.slice(0, 8)} →
            </Link>
          </MetaItem>
        )}
        {/* The run that caused this one — a clickable causal edge. For an execution an agent submitted, this is how you walk back to that
            agent turn (a demand graph, and an audit trail). */}
        {causedByRunId && (
          <MetaItem label={t('metaCausedBy')}>
            <Link
              href={`/${workspace}/run/${encodeURIComponent(causedByRunId)}`}
              className="inline-flex items-center gap-1 font-mono text-[13px] text-link transition-colors hover:text-foreground"
            >
              {causedByRunId.slice(0, 8)} →
            </Link>
          </MetaItem>
        )}
        {/* A case submitted inside a session (a playground) → to that session run. A scorecard child is handled by the cell above. */}
        {sessionRunId && (
          <MetaItem label={t('metaSessionRun')}>
            <Link
              href={`/${workspace}/run/${encodeURIComponent(sessionRunId)}`}
              className="inline-flex items-center gap-1 font-mono text-[13px] text-link transition-colors hover:text-foreground"
            >
              {sessionRunId.slice(0, 8)} →
            </Link>
          </MetaItem>
        )}
      </Card>

      {/* Request — what it was asked to do. Only runs that persist the case body have it (a standalone submit, a playground case), and
          without it the detail could not show "what task did this run receive" at all. No body, no section. */}
      {caseSpec && caseSpec.task.trim() !== '' && (
        <section className="space-y-2.5">
          <SectionHeader
            title={t('requestTitle')}
            action={
              caseSpec.timeoutSec !== undefined ? (
                <span className="font-mono text-[11px] text-faint">
                  {t('requestTimeout', { sec: caseSpec.timeoutSec })}
                </span>
              ) : undefined
            }
          />
          <Card className="p-4">
            <p className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-[13px] leading-relaxed">
              {caseSpec.task}
            </p>
            {caseSpec.tags.length > 0 && (
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {caseSpec.tags.map((tag) => (
                  <Badge key={tag} tone="outline">
                    {tag}
                  </Badge>
                ))}
              </div>
            )}
          </Card>
        </section>
      )}

      {/* Usage (this run's own economics) — cost · tokens · calls, derived from the trace. A scorecard only aggregates
          these across cases; a single run reports its own. Hidden until there's a non-zero trace-derived usage. */}
      {usage && (usage.usd > 0 || usage.totalTokens > 0) && (
        <Card className="flex flex-wrap items-center gap-x-8 gap-y-2 p-4">
          <UsageStat label={t('usageCost')} value={fmtUsd(usage.usd)} />
          <UsageStat
            label={t('usageTokens')}
            value={fmtTokens(usage.totalTokens)}
            hint={t('usageTokensBreakdown', {
              prompt: usage.promptTokens,
              completion: usage.completionTokens,
            })}
          />
          <UsageStat label={t('usageCalls')} value={String(usage.calls)} />
          {/* The cap of the budget it was delegated — which envelope this run draws from (a slice delegated by an agent is the common one).
              With no cap there is no cell at all. */}
          {run.envelope?.capUsd !== undefined && (
            <UsageStat label={t('usageBudget')} value={fmtUsd(run.envelope.capUsd)} />
          )}
        </Card>
      )}

      {run.error && (
        <Callout tone="danger" hint={run.error.message}>
          {run.error.code}
        </Callout>
      )}

      {(run.status === 'queued' || run.status === 'running') && (
        <section className="space-y-4">
          {/* live trace deep-link — the platform trace is accumulating under this correlation id right now */}
          {run.liveTrace && (
            <Callout tone="info" hint={`everdict.run_id=${run.liveTrace.runId}`}>
              {t('liveTrace', { kind: run.liveTrace.kind })}{' '}
              <a
                href={run.liveTrace.endpoint}
                target="_blank"
                rel="noreferrer"
                className="break-all font-mono underline underline-offset-2"
              >
                {run.liveTrace.endpoint}
              </a>
            </Callout>
          )}
          {/* Case placement (runtime debugging) — polls how far the cluster accepted the case (blocked-capacity verdict, node,
              orchestrator event feed); on a run with no placement information the widget self-nulls (no empty section) */}
          <RunPlacement runId={run.id} initialStatus={run.status} />
          {/* Topology health (service harnesses) — per-service state of a warm topology (restarts, OOM, recent events) plus per-row log expansion;
              on anything that is not a service harness the widget self-nulls */}
          <RunTopology runId={run.id} initialStatus={run.status} />
          {/* The live workbench — when wide, two columns of "environment main panel + observation rail" (a vertical fallback when narrow;
              measured against the CONTAINER rather than the viewport, for the moment an infra panel splits the screen). The main column is
              decided by the environment kind: browser/os-use get the live screen, repo gets the file workbench — both self-null, so whichever
              does not apply is not drawn. The rail is trace, logs and terminal (the observation axis). Every widget self-nulls on the client,
              so a whole column can end up empty — an empty column folds with empty:hidden, and the two-column split is applied only when BOTH
              sides have content (:has). Otherwise a screenless run leaves the left 3fr empty and traps the trace at rail width. */}
          <RunLiveStreamProvider
            runId={run.id}
            lanes={showFileWorkbench ? 'screen,fs' : 'screen'}
            initialStatus={run.status}
          >
            <div className="grid gap-4 @5xl:[&:has([data-live-main]>*):has([data-live-rail]>*)]:grid-cols-[minmax(0,3fr)_minmax(20rem,2fr)]">
              <div data-live-main className="min-w-0 space-y-4 empty:hidden">
                {/* The live screen — on a browser (browser-use etc.) or os-use case, polls the running screen every 2s as CDP/scrot/runner-pushed
                  frames */}
                <LiveScreen runId={run.id} initialStatus={run.status} />
                {/* The live repo workbench — on a repo case, polls the sandbox working tree every 4s as a file explorer (M/A/D badges) plus a
                  read-only editor/diff, and "follow" opens whatever file the agent just changed. Attempted only on a run that declared the exec
                  channel, and with no repo in the sandbox the widget self-nulls */}
                {showFileWorkbench && (
                  <RunFileWorkbench runId={run.id} initialStatus={run.status} />
                )}
              </div>
              <div data-live-rail className="min-w-0 space-y-4 empty:hidden">
                {/* The live trace (observability ⑨) — polls the trajectory accumulating during the run (dispatch marks + runner pushes + managed
                  event sentinels) every 3s and draws it as a pre-seal preview */}
                <LiveTrace runId={run.id} initialStatus={run.status} />
                {/* Logs and terminal only when the run DECLARED the channel (attach) — a run with nowhere to attach does not get a panel that
                  stays empty forever. An older eval/command run that declared nothing keeps opening both, as before. */}
                {showLiveLogs && (
                  <div className="space-y-2.5">
                    <SectionHeader title={t('liveLogs')} />
                    <Card className="p-4">
                      <LiveLogs runId={run.id} initialStatus={run.status} />
                    </Card>
                  </div>
                )}
                {/* The sandbox terminal — an interactive shell into the running case container (cd and env persist). The shell is a REAL process in
                  the sandbox, so it attaches only when "open a shell" is pressed (creator/admin, enforced by the control plane) */}
                {showTerminal && (
                  <div className="space-y-2.5">
                    <SectionHeader title={t('sandbox')} />
                    <Card className="p-4">
                      <LiveTerminal runId={run.id} />
                    </Card>
                  </div>
                )}
              </div>
            </div>
          </RunLiveStreamProvider>
        </section>
      )}

      {/* Replay — the anchor section of a finished run. It scrubs the agent trace (common to every harness) on the wall clock and overlays the
          screen at that moment when there are recorded frames. The header's "replay" badge jumps here. docs/architecture/replay.md */}
      {mountsReplay && (
        <div id="replay" className="scroll-mt-6">
          <ReplayPlayer runId={run.id} initialStatus={run.status} trace={trace} />
        </div>
      )}

      {/* Result — the single slot that is swapped per kind. An eval gets a one-line verdict plus the metric table (grounds on row expansion), an
          agent turn gets a jump to that conversation, a sandbox gets the session summary. A score is the RESULT OF AN EVAL rather than a universal
          result, so the permanently empty section that said "no scores yet" on families that have none is gone.
          A scorecard's case run does not repeat its scores here — the authoritative surface for scores is the scorecard detail (which already owns
          the per-case verdict and metric table), and the run detail is the EXECUTION record (replay, live, trajectory, discussion). */}
      {!run.parentScorecardId && (
        <RunOutcome
          run={run}
          action={
            run.group?.role === 'turn' ? (
              <OpenConversationButton sessionId={run.group.id} />
            ) : undefined
          }
        />
      )}

      {/* Evidence — the SAME reading surface as Settings › Observability's sealed-trajectory detail (rollup ·
          plane chips · event list left / full payload right). The run page's bespoke vertical timeline is gone:
          one trace UI, so a payload read here is the payload read there. Hidden entirely when there is nothing
          sealed yet (empty sections are never placeholders). The panes scroll on their own, so the card fixes a
          height; TrajectoryView is its own @container, so it stacks when the infra panel narrows this column. */}
      {segments.length > 0 && (
        <section className="space-y-2.5">
          <SectionHeader title={t('trace')} />
          {/* Served from the owned store (no row embed): say so — the evidence survives independent of any
              external platform, and `source` is its provenance (run | otlp | import). */}
          {trajectorySource !== undefined && (
            <p className="text-xs text-muted-foreground">
              {t('sealedEvidence', { source: trajectorySource })}
            </p>
          )}
          {/* A trace longer than one page says so, and pages — never a silent truncation, which would let a
              reader draw a conclusion from evidence the screen quietly cut. */}
          {traceWindow !== undefined && (traceWindow.nextAfter !== undefined || traceWindow.from > 0) && (
            <p className="flex items-center gap-3 text-xs text-muted-foreground">
              <span>
                {t('traceWindow', {
                  from: traceWindow.from + 1,
                  to: traceWindow.from + traceWindow.shown,
                  total: traceWindow.total,
                })}
              </span>
              {traceWindow.from > 0 && (
                <Link
                  className="underline"
                  href={`?traceAfter=${Math.max(0, traceWindow.from - TRACE_PAGE)}`}
                >
                  {t('tracePrev')}
                </Link>
              )}
              {traceWindow.nextAfter !== undefined && (
                <Link className="underline" href={`?traceAfter=${traceWindow.nextAfter}`}>
                  {t('traceNext')}
                </Link>
              )}
            </p>
          )}
          <Card className="h-[68vh] min-h-[420px] p-4">
            <TrajectoryView segments={segments} />
          </Card>
        </section>
      )}

      {snapshot && snapshotHasContent(snapshot) && (
        <section className="space-y-2.5">
          <SectionHeader title={t('snapshot', { kind: String(snapshot.kind) })} />
          <Card className="space-y-3 p-4">
            {/* os-use screenshot — inline base64 (dev) or object storage URL (offloaded). The final screen the agent saw. */}
            {osUseShotSrc(snapshot) && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={osUseShotSrc(snapshot)}
                alt="os-use screenshot"
                className="max-h-[480px] w-auto max-w-full rounded-lg border"
              />
            )}
            {/* prompt (environment-less QA) — the final answer text. Its main signal is the trace so it is often empty, and this section appears
                only when there is a value (the snapshotHasContent gate). It used to render raw `{kind:"prompt",output:""}` JSON and read as "an empty snapshot every time". */}
            {snapshot.kind === 'prompt' && snapshot.output && (
              <div>
                <dt className="text-[11px] font-[510] uppercase tracking-wide text-faint">
                  {t('snapshotOutput')}
                </dt>
                <dd className="mt-0.5 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/40 p-2 font-mono text-[13px]">
                  {snapshot.output}
                </dd>
              </div>
            )}
            {/* os-use — the titles of visible windows (OSWorld-style desktop). */}
            {snapshot.kind === 'os-use' && snapshot.windows && snapshot.windows.length > 0 && (
              <div>
                <dt className="text-[11px] font-[510] uppercase tracking-wide text-faint">
                  {t('snapshotWindows')}
                </dt>
                <dd className="mt-0.5 flex flex-wrap gap-1.5">
                  {snapshot.windows.map((w, i) => (
                    <span
                      key={`${w}-${i}`}
                      className="rounded-md border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[12px] text-muted-foreground"
                    >
                      {w}
                    </span>
                  ))}
                </dd>
              </div>
            )}
            {/* repo — the final changed-files list + the git diff (the coding harness's result world). */}
            {snapshot.kind === 'repo' && (
              <div className="space-y-2">
                {snapshot.changedFiles && snapshot.changedFiles.length > 0 && (
                  <div>
                    <dt className="text-[11px] font-[510] uppercase tracking-wide text-faint">
                      {t('snapshotChangedFiles')}
                    </dt>
                    <dd className="mt-0.5 flex flex-wrap gap-1.5">
                      {snapshot.changedFiles.map((f) => (
                        <span
                          key={f}
                          className="rounded-md border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[12px] text-muted-foreground"
                        >
                          {f}
                        </span>
                      ))}
                    </dd>
                  </div>
                )}
                {snapshot.diff && (
                  <div>
                    <dt className="text-[11px] font-[510] uppercase tracking-wide text-faint">
                      {t('snapshotDiff')}
                    </dt>
                    <dd className="mt-0.5 max-h-80 overflow-auto whitespace-pre rounded-lg border border-border bg-muted/40 p-2 font-mono text-[12px] text-muted-foreground">
                      {snapshot.diff}
                    </dd>
                  </div>
                )}
              </div>
            )}
            {/* browser (service-topology: browser-use, etc.) — the final URL the agent reached + an extracted DOM excerpt. */}
            {snapshot.kind === 'browser' && (
              <div className="space-y-2">
                {snapshot.url && (
                  <div>
                    <dt className="text-[11px] font-[510] uppercase tracking-wide text-faint">
                      final url
                    </dt>
                    <dd className="mt-0.5 break-all font-mono text-[13px]">{snapshot.url}</dd>
                  </div>
                )}
                {snapshot.dom && (
                  <div>
                    <dt className="text-[11px] font-[510] uppercase tracking-wide text-faint">
                      dom / extracted
                    </dt>
                    <dd className="mt-0.5 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/40 p-2 font-mono text-[12px] text-muted-foreground">
                      {snapshot.dom}
                    </dd>
                  </div>
                )}
                {/* Full page DOM offloaded to object storage — the inline `dom` above is only an 8KB preview. The ref is a
                    presigned URL (S3/MinIO), so a plain download link; hidden for the dev in-memory store's memory:// ref. */}
                {snapshot.domRef && /^https?:\/\//.test(snapshot.domRef) && (
                  <a
                    href={snapshot.domRef}
                    target="_blank"
                    rel="noreferrer"
                    download
                    className="inline-flex items-center gap-1.5 text-[12px] font-[510] text-link transition-colors hover:text-foreground"
                  >
                    <Download className="size-3.5" />
                    {t('downloadDom')}
                  </a>
                )}
              </div>
            )}
          </Card>
        </section>
      )}

      <CommentsSection
        workspace={workspace}
        resourceType="run"
        resourceId={id}
        title={t('discuss')}
      />
    </div>
  )
}
