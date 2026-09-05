'use client'

import { useEffect, useState, useTransition } from 'react'
import { ChevronLeft, ChevronRight, Download, ExternalLink, Timer, X } from 'lucide-react'
import { useTranslations } from 'next-intl'

import {
  asSingleSegment,
  getTrajectoryAction,
  TrajectoryView,
  type TrajectorySegment,
} from '@/features/browse-traces'
import {
  classifyMetric,
  classifyScoreDetail,
  fmtMetricValue,
  groupMetricRows,
  isUnmeasuredScore,
} from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { buttonVariants } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { EnvBadge, GraderBadge } from '@/shared/ui/case-badges'
import { CopyLinkButton } from '@/shared/ui/copy-link-button'
import { Dialog } from '@/shared/ui/dialog'
import { ExpandableText } from '@/shared/ui/expandable-text'
import { Link } from '@/shared/ui/link'
import { Markdown } from '@/shared/ui/markdown'
import { MetricLabel } from '@/shared/ui/metric-label'
import { ScoreDetail } from '@/shared/ui/score-detail'
import { Tooltip } from '@/shared/ui/tooltip'

import { getScorecardCaseAction } from '../api/case-detail'
import {
  findCaseEvidence,
  type CaseExecutionView,
  type CaseScoreEvidence,
  type CaseScoreView,
  type ScorecardCaseDetail,
  type ScorecardCaseView,
} from '../model/case-view'

// The case detail dialog — it answers an analyst's three questions from top to bottom:
// ① which case was this (the dataset task) → ② how did it actually execute (the agent trajectory plus the snapshot/error) →
// ③ how was it judged (the grounds for the verdict plus judge/grader scores and reasoning). The trajectory opens through TrajectoryView,
// the single read surface for sealed evidence (the child run → the trajectory ledger, else the embedded case trace). The header, meta,
// prev/next and ←/→ share TrajectoryDetailDialog's grammar.
//
// **The evidence arrives per case, on open.** The task body, each score's rationale, the full error text and
// the screenshot do not ride the list payload — on a batch of hundreds that WAS why the screen stalled. A row
// knows only whether they exist; the contents come through one server action here, the same door the trace
// already went through.
export function CaseDetailDialog({
  workspace,
  scorecardId,
  item: c,
  onClose,
  nav,
}: {
  workspace: string
  scorecardId: string
  item: ScorecardCaseView
  onClose: () => void
  // index < 0 = a case outside the current filter (opened from the timeline) — no sibling control is stood up.
  nav: { index: number; total: number; onPrev: () => void; onNext: () => void }
}) {
  const t = useTranslations('scorecardsPage')
  const [detail, setDetail] = useState<ScorecardCaseDetail | undefined>()
  const [segments, setSegments] = useState<TrajectorySegment[] | undefined>()
  const [traceError, setTraceError] = useState<string | undefined>()
  // How much of the trace this dialog holds, and how much the seal says there is.
  const [traceLoaded, setTraceLoaded] = useState(0)
  const [traceTotal, setTraceTotal] = useState(0)
  // The store's answer to "is there more, from where" — never counted against a total that sums other planes.
  const [traceNextAfter, setTraceNextAfter] = useState<number | undefined>()
  const [pending, start] = useTransition()

  // Execution evidence and score evidence are fetched for this one case on open: with a child run the
  // trajectory comes from the ledger (several planes); without one, the scorecard's embedded case trace
  // (a single plane) rides the same round trip as the evidence.
  useEffect(() => {
    setDetail(undefined)
    setSegments(undefined)
    setTraceError(undefined)
    const runId = c.runId
    const embedded = runId === undefined && c.hasTrace
    start(async () => {
      const res = await getScorecardCaseAction(scorecardId, c.caseId, c.occurrence, embedded)
      if (!res.ok) {
        setTraceError(res.error)
        return
      }
      setDetail(res.detail)
      if (embedded)
        setSegments(
          res.events !== undefined && res.events.length > 0
            ? asSingleSegment(res.events, 'run')
            : []
        )
      if (runId === undefined) return
      // A window, not the whole trace: a case can carry somebody else's long agent run, and the dialog
      // should open at the same speed whatever the run's length. `loadMoreTrace` fetches the rest.
      const trajectory = await getTrajectoryAction(runId)
      if (trajectory.ok) {
        setSegments(trajectory.segments)
        setTraceLoaded(trajectory.events.length)
        setTraceTotal(trajectory.total)
        setTraceNextAfter(trajectory.nextAfter)
      } else setTraceError(trajectory.error)
    })
  }, [scorecardId, c.key, c.caseId, c.occurrence, c.runId, c.hasTrace])

  // Append the next window of the case's trace onto the planes already drawn — same merge as the
  // observability dialog: a page belongs to whichever emitters it carried, and an absent emitter keeps what
  // it had rather than being reset.
  const loadMoreTrace = () => {
    const runId = c.runId
    if (runId === undefined) return
    start(async () => {
      const more = await getTrajectoryAction(runId, traceNextAfter ?? traceLoaded)
      if (!more.ok) {
        setTraceError(more.error)
        return
      }
      setSegments((held) => {
        if (!held) return more.segments
        const byEmitter = new Map(more.segments.map((seg) => [seg.emitter, seg]))
        const merged = held.map((seg) => {
          const extra = byEmitter.get(seg.emitter)
          byEmitter.delete(seg.emitter)
          return extra ? { ...seg, events: [...seg.events, ...extra.events] } : seg
        })
        return [...merged, ...byEmitter.values()]
      })
      setTraceLoaded((n) => n + more.events.length)
      setTraceNextAfter(more.nextAfter)
    })
  }

  // ←/→ moves between sibling cases (the same gesture as the trajectory and external trace details).
  const navigable = nav.index >= 0
  const hasPrev = navigable && nav.index > 0
  const hasNext = navigable && nav.index < nav.total - 1
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'ArrowLeft' && hasPrev) nav.onPrev()
      if (e.key === 'ArrowRight' && hasNext) nav.onNext()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [nav, hasPrev, hasNext])

  const caseMetrics = c.scores.map((s) => s.metric)
  const scoreGroups = groupMetricRows(c.scores)
  const hasTrajectory = c.runId !== undefined || c.hasTrace
  const hasExecution =
    hasTrajectory ||
    c.snapshot !== undefined ||
    c.hasScreenshot ||
    c.errorCount > 0 ||
    c.runnerHint !== undefined ||
    c.execution !== undefined
  const hasIdentity =
    c.taskSummary !== undefined || c.envKind !== undefined || (c.graderIds?.length ?? 0) > 0

  return (
    <Dialog
      open
      onClose={onClose}
      labelledBy="scorecard-case-dialog-title"
      className="flex h-[92vh] max-h-[92vh] max-w-[1200px] flex-col"
    >
      {/* On a narrow screen the action group wraps under the title — so the header does not overflow even in a narrow dialog. */}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-border px-5 py-4">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Badge tone={c.verdict == null ? 'neutral' : c.verdict ? 'success' : 'danger'}>
            {c.verdict == null ? 'SKIP' : c.verdict ? 'PASS' : 'FAIL'}
          </Badge>
          <h2
            id="scorecard-case-dialog-title"
            className="truncate font-mono text-[15px] font-[600]"
          >
            {c.caseId}
          </h2>
          {/* The trial badge — the same caseId appears on several rows, so the header says WHICH trial is being viewed. */}
          {c.trial !== undefined && (
            <Badge tone="neutral">{t('caseTrialBadge', { n: c.trial })}</Badge>
          )}
          {c.snapshot?.kind && <Badge tone="neutral">{c.snapshot.kind}</Badge>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* This case's child run — the door to the full execution detail (usage, provenance, live channels). */}
          {c.runId !== undefined && (
            <Link
              href={`/${workspace}/run/${encodeURIComponent(c.runId)}`}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              <ExternalLink className="size-4" />
              {t('caseOpenRun')}
            </Link>
          )}
          {/* The trace sink deep link — the original or exported trace on the observability platform. */}
          {c.exportUrl !== undefined && (
            <a
              href={c.exportUrl}
              target="_blank"
              rel="noreferrer"
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              {c.sinkKind ?? 'trace'} ↗
            </a>
          )}
          {/* The open state is mirrored into the URL as ?case=, so the current address IS this case's shareable link. */}
          <CopyLinkButton
            label={t('caseCopyLink')}
            message={t('caseLinkCopied')}
            className="rounded-md border border-border p-1.5 text-muted-foreground"
          />
          {navigable && (
            <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
              <button
                type="button"
                onClick={nav.onPrev}
                disabled={!hasPrev}
                aria-label={t('casePrev')}
                className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-35 disabled:hover:text-muted-foreground"
              >
                <ChevronLeft className="size-4" />
              </button>
              <span className="min-w-12 text-center font-mono text-[11px] tabular-nums text-faint">
                {nav.index + 1} / {nav.total}
              </span>
              <button
                type="button"
                onClick={nav.onNext}
                disabled={!hasNext}
                aria-label={t('caseNext')}
                className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-35 disabled:hover:text-muted-foreground"
              >
                <ChevronRight className="size-4" />
              </button>
            </div>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label={t('caseClose')}
            className="rounded-md border border-border p-1.5 text-muted-foreground hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-5">
        {/* ① Which case was this — the dataset case definition (the task body plus environment/grading/tag meta). */}
        {hasIdentity && (
          <section className="space-y-2">
            <SectionLabel>{t('caseDialogTask')}</SectionLabel>
            <div className="flex flex-wrap items-center gap-1.5">
              {c.envKind && <EnvBadge kind={c.envKind} />}
              {(c.graderIds ?? []).map((g, i) => (
                <GraderBadge key={`${g}-${i}`} id={g} />
              ))}
              {typeof c.timeoutSec === 'number' && (
                <span className="inline-flex items-center gap-1 text-[11px] text-faint">
                  <Timer className="size-3" />
                  {c.timeoutSec}s
                </span>
              )}
              {(c.tags ?? []).map((tag) => (
                <span key={tag} className="text-[10.5px] text-faint">
                  #{tag}
                </span>
              ))}
            </div>
            {/* The body arrives after opening — until it does, the one line the list already had holds the
                place (rather than a blank). */}
            {(detail?.task ?? c.taskSummary) !== undefined && (
              <div className="rounded-lg border border-border bg-card p-3.5">
                {detail?.task !== undefined ? (
                  <Markdown content={detail.task} />
                ) : (
                  <p className="text-[13px] text-muted-foreground">{c.taskSummary}</p>
                )}
              </div>
            )}
          </section>
        )}

        {/* ② How did it actually execute — the agent trajectory plus what the execution left behind (screenshot, final URL, DOM, errors, runner hints). */}
        {hasExecution && (
          <section className="space-y-2.5">
            <SectionLabel>{t('caseDialogExecution')}</SectionLabel>
            {/* Which WORLD it ran in — one line above the trajectory. With no record it hides entirely (the empty-section convention). */}
            {c.execution && <ExecutionStrip execution={c.execution} />}
            {traceError !== undefined ? (
              <Callout tone="danger">{t('caseTraceError', { error: traceError })}</Callout>
            ) : pending && segments === undefined ? (
              <p className="px-1 py-2 text-[12px] text-faint">{t('caseTraceLoading')}</p>
            ) : segments !== undefined && segments.length > 0 ? (
              // TrajectoryView needs its host to give it a definite height — the same rule as the run detail's evidence section.
              <div className="h-[46vh] min-h-[320px] rounded-lg border border-border bg-card p-3">
                {traceNextAfter !== undefined && (
                  <p className="flex items-center gap-3 pb-2 text-[12px] text-faint">
                    <span>{t('caseTraceWindow', { shown: traceLoaded, total: traceTotal })}</span>
                    <button
                      className="underline"
                      disabled={pending}
                      onClick={loadMoreTrace}
                      type="button"
                    >
                      {pending ? t('caseTraceLoading') : t('caseTraceMore')}
                    </button>
                  </p>
                )}
                <TrajectoryView segments={segments} />
              </div>
            ) : hasTrajectory ? (
              <p className="text-[12px] text-muted-foreground">{t('caseTraceEmpty')}</p>
            ) : null}
            {/* The os-use screenshot — the very screen the VLM graded. As base64 it is hundreds of KB per
                case, so it is fetched here and never in the list. */}
            {detail?.screenshotSrc !== undefined && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={detail.screenshotSrc}
                alt={`${c.caseId} screenshot`}
                className="max-h-80 w-auto rounded-lg border"
              />
            )}
            {/* browser — the final URL the agent reached (plus a download of the offloaded full DOM). */}
            {c.snapshot?.url && (
              <p className="break-all font-mono text-[12px] text-muted-foreground">
                <span className="font-[510] text-foreground">final url</span> · {c.snapshot.url}
              </p>
            )}
            {c.snapshot?.domRef && (
              <a
                href={c.snapshot.domRef}
                target="_blank"
                rel="noreferrer"
                download
                className="inline-flex items-center gap-1.5 text-[12px] font-[510] text-link transition-colors hover:text-foreground"
              >
                <Download className="size-3.5" />
                {t('downloadDom')}
              </a>
            )}
            {/* How the case died — the trace's error events (a harness crash, a dispatch error). Until the
                full text arrives, the first line the list already carried stands, so opening a failed case is
                never a moment of silence. */}
            {(detail?.errors ?? (c.errorSummary !== undefined ? [c.errorSummary] : [])).map(
              (message, i) => (
                <div
                  key={`case-error-${i}`}
                  className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 font-mono text-[12px] leading-relaxed text-destructive"
                >
                  <ExpandableText
                    text={message}
                    prefix={
                      <>
                        <span className="font-[560]">error</span> ·{' '}
                      </>
                    }
                    className="whitespace-pre-wrap break-words"
                  />
                </div>
              )
            )}
            {/* The self-hosted runner failure hint — a sentence the server already localized after reading the roster. */}
            {c.runnerHint && (
              <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] leading-relaxed text-amber-700 dark:text-amber-400">
                {c.runnerHint}
              </p>
            )}
          </section>
        )}

        {/* ③ How was it judged — the grounds for the verdict (which authority layer decided) plus the score rows (reasoning expands; a failing row is expanded by default). */}
        <section className="space-y-2.5">
          <SectionLabel>{t('caseDialogEvaluation')}</SectionLabel>
          {(c.verdict !== undefined || c.verdictBasis !== undefined) && (
            <div className="flex flex-wrap items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-2 shadow-raise">
              {c.verdict !== undefined && (
                <Badge tone={c.verdict ? 'success' : 'danger'}>{c.verdict ? 'PASS' : 'FAIL'}</Badge>
              )}
              {c.verdictBasis && (
                <>
                  <span className="text-[12.5px] text-muted-foreground">
                    {t('caseDecidedBy', {
                      authority: c.verdictBasis.authority,
                      aggregation: c.verdictBasis.aggregation,
                    })}
                  </span>
                  {c.verdictBasis.deciders.map((d) => (
                    <Badge
                      key={`${d.graderId}:${d.metric}`}
                      title={d.graderId}
                      tone={d.pass ? 'success' : 'danger'}
                    >
                      {d.metric} {d.pass ? '✓' : '✗'}
                    </Badge>
                  ))}
                </>
              )}
            </div>
          )}
          {c.scores.length === 0 ? (
            <p className="text-[12px] text-muted-foreground">{t('noScores')}</p>
          ) : (
            <div className="overflow-hidden rounded-lg border border-border bg-card">
              {scoreGroups.map((group) => (
                <div key={`${group.row.graderId}:${group.row.metric}`}>
                  <ScoreRow
                    score={group.row}
                    siblings={caseMetrics}
                    evidence={findCaseEvidence(detail?.evidence, group.row)}
                  />
                  {group.criteria.map((criterion) => (
                    <ScoreRow
                      key={criterion.row.metric}
                      score={criterion.row}
                      siblings={caseMetrics}
                      evidence={findCaseEvidence(detail?.evidence, criterion.row)}
                      nested
                    />
                  ))}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </Dialog>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] font-[510] uppercase tracking-wide text-faint">{children}</p>
}

// The execution manifest strip — "which world did this case actually run in". Where the scorecard manifest pins the DEFINITION of the
// evaluation (dataset, harness and judge versions), this pins its WORLD.
// An `osResolved` of `defaulted` means the case never used an os at all — a fact distinct from a declared linux, so it is stated as its own
// badge (with the explanation in a tooltip rather than as inline prose).
function ExecutionStrip({ execution }: { execution: CaseExecutionView }) {
  const t = useTranslations('scorecardsPage')
  const defaulted = execution.osResolved === 'defaulted'
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-border bg-card px-3 py-2 text-[12px]">
      <span className="text-faint">{t('caseWorldLabel')}</span>
      <Badge tone="neutral">{execution.os}</Badge>
      {defaulted && (
        <Tooltip content={t('caseWorldDefaultedHint')}>
          <span className="cursor-default rounded border border-dashed border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
            {t('caseWorldDefaulted')}
          </span>
        </Tooltip>
      )}
      {execution.driver !== undefined && (
        <ExecutionFact label={t('caseWorldDriver')} value={execution.driver} />
      )}
      {execution.runtime !== undefined && (
        <ExecutionFact label={t('caseWorldRuntime')} value={execution.runtime} />
      )}
      {execution.image !== undefined && (
        <ExecutionFact label={t('caseWorldImage')} value={execution.image} truncate />
      )}
    </div>
  )
}

function ExecutionFact({
  label,
  value,
  truncate,
}: {
  label: string
  value: string
  truncate?: boolean
}) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="text-faint">{label}</span>
      {/* An image reference is long — truncate it rather than letting it break the strip, and give the whole thing in `title`. */}
      <span
        className={cn(
          'font-mono text-[11.5px] text-muted-foreground',
          truncate && 'max-w-64 truncate'
        )}
        title={truncate ? value : undefined}
      >
        {value}
      </span>
    </span>
  )
}

// One score's value — a categorical `label` verbatim (gold / correct / B), otherwise the unit-inferred format. The verdict badge stands
// separately, so 0/1 is shown as the real value here, exactly as the run detail's value cell does.
function displayValue(s: CaseScoreView): string {
  if (s.label !== undefined && s.label !== '') return s.label
  // Unmeasured rows are filtered out before this is called (isUnmeasuredScore) — a dash is still the honest mark when there is no value.
  if (s.value === undefined) return '–'
  return fmtMetricValue(classifyMetric({ metric: s.metric, mean: s.value }), s.value)
}

// One metric row — the same row grammar as the run detail's EvalOutcome: it expands when there is a `detail` (the grounds for the verdict),
// and a FAILING row is expanded by default. "Why did it fail" being folded away deepest was the previous case card's central problem.
function ScoreRow({
  score,
  siblings,
  evidence,
  nested,
}: {
  score: CaseScoreView
  siblings: string[]
  // Evidence arrives after the dialog opens — until then this is an ordinary row with nothing to expand.
  evidence?: CaseScoreEvidence
  nested?: boolean
}) {
  const t = useTranslations('scorecardsPage')
  const hasDetail = classifyScoreDetail(evidence?.detail) !== undefined
  const unmeasured = isUnmeasuredScore(score)
  // undefined = nobody has pressed it yet. That way a failing row still opens itself when its evidence
  // arrives late, and a row somebody closed is not re-opened by that arrival.
  const [toggled, setToggled] = useState<boolean | undefined>(undefined)
  // Gated on hasDetail as well: stepping to a sibling case reuses this row in place, so a `toggled` left
  // over from the previous case could otherwise mark a row with no evidence as open.
  const open = hasDetail && (toggled ?? score.pass === false)
  const body = (
    <div
      className={cn(
        'grid w-full items-center gap-3 px-3 py-2 text-left [grid-template-columns:minmax(0,1fr)_auto_auto]',
        hasDetail && 'transition-colors hover:bg-elevated/50'
      )}
    >
      <span className={cn('flex min-w-0 items-center gap-2', nested && 'pl-5')}>
        {hasDetail && (
          <ChevronRight
            className={cn('size-3.5 shrink-0 text-faint transition-transform', open && 'rotate-90')}
          />
        )}
        <span className="min-w-0 truncate font-mono text-[11px] text-faint">{score.graderId}</span>
        <MetricLabel metric={score.metric} siblings={siblings} />
      </span>
      <span className="font-mono text-[13px] font-[510] tabular-nums">
        {unmeasured ? t('scoreUnmeasured') : displayValue(score)}
      </span>
      <span className="w-12 text-right">
        {score.pass != null && !unmeasured && (
          <Badge tone={score.pass ? 'success' : 'danger'}>{score.pass ? 'pass' : 'fail'}</Badge>
        )}
      </span>
    </div>
  )
  return (
    <div className="border-b border-border/60 last:border-b-0">
      {hasDetail ? (
        <button type="button" onClick={() => setToggled(!open)} className="block w-full">
          {body}
        </button>
      ) : (
        body
      )}
      {/* On a row that is not a measurement, "why it could not be measured" IS the row — a value cell saying
          only "unmeasured", with the reason nowhere, leaves nothing to read. */}
      {unmeasured && evidence?.reason !== undefined && (
        <p className="px-3 pb-2 text-[12px] text-muted-foreground">{evidence.reason}</p>
      )}
      {open && <ScoreDetail detail={evidence?.detail} className="mx-3 mb-3" />}
    </div>
  )
}
