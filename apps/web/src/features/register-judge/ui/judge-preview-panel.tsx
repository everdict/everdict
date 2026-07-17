'use client'

import { useEffect, useState, useTransition } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { Check, ChevronDown, ChevronRight, ExternalLink, Loader2, Play } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { inspectTraceAction, TraceBrowser, TraceEventList } from '@/features/browse-traces'
import type { TraceInspectResult, TraceSummary } from '@/entities/trace'
import type { TraceSourceConfig } from '@/entities/trace-source'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Input, Label } from '@/shared/ui/input'

import {
  judgeTryRunAction,
  tryJudgeAction,
  type JudgeScore,
  type JudgeTryRunState,
  type TryJudgeResult,
} from '../api/register-judge'

type Step = 'pick' | 'run'

// The judge id off the draft spec (unknown from getSpec) — used to stamp the production metric prefix on display.
function judgeIdOf(spec: unknown): string | undefined {
  if (typeof spec !== 'object' || spec === null) return undefined
  const id = (spec as Record<string, unknown>).id
  return typeof id === 'string' && id ? id : undefined
}

// The run record keeps the script's raw metrics ("judge" / "judge:<sub>"); production scoring rewrites the prefix
// to judge:<id>. Mirror that here so the preview shows exactly what a scorecard will show.
function stampJudgeMetric(scores: JudgeScore[], judgeId: string | undefined): JudgeScore[] {
  if (!judgeId) return scores
  return scores.map((s) => ({ ...s, metric: s.metric.replace(/^judge/, `judge:${judgeId}`) }))
}

// A code judge's error verdicts carry the run's stderr/stdout inside the score detail ([grader-error] … /
// skipped: …) — surface those as a log block, not a one-liner.
function isErrorDetail(detail: unknown): detail is string {
  return (
    typeof detail === 'string' &&
    (detail.includes('[grader-error]') || detail.startsWith('skipped:'))
  )
}

// The wizard's step rail — reachable steps are clickable, the completed pick shows a check.
function StepRail({
  step,
  picked,
  canRun,
  onGo,
}: {
  step: Step
  picked: boolean
  canRun: boolean
  onGo: (s: Step) => void
}) {
  const t = useTranslations('judgePreview')
  const items: { id: Step; label: string; enabled: boolean; done: boolean }[] = [
    { id: 'pick', label: t('stepPick'), enabled: true, done: picked && step !== 'pick' },
    { id: 'run', label: t('stepRun'), enabled: canRun, done: false },
  ]
  return (
    <ol className="flex flex-wrap items-center gap-1">
      {items.map((it, i) => (
        <li key={it.id} className="flex items-center gap-1">
          {i > 0 && <ChevronRight className="size-3.5 text-faint" />}
          <button
            type="button"
            disabled={!it.enabled}
            onClick={() => onGo(it.id)}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] transition-colors',
              step === it.id
                ? 'bg-secondary font-[510] text-foreground'
                : it.enabled
                  ? 'text-muted-foreground hover:text-foreground'
                  : 'cursor-default text-faint'
            )}
          >
            <span
              className={cn(
                'flex size-4 items-center justify-center rounded-full text-[10px] font-[600]',
                step === it.id
                  ? 'bg-primary text-primary-foreground'
                  : it.done
                    ? 'bg-[var(--color-success)]/15 text-[var(--color-success)]'
                    : 'bg-muted text-muted-foreground'
              )}
            >
              {it.done ? <Check className="size-2.5" /> : i + 1}
            </span>
            {it.label}
          </button>
        </li>
      ))}
    </ol>
  )
}

// One verdict row — an error detail (crashed judge: [grader-error] with stderr, or a skip reason) renders as a
// log block so the debugging signal is readable, not truncated into a chip.
function ScoreRow({ score }: { score: JudgeScore }) {
  const errorDetail = isErrorDetail(score.detail) ? score.detail : undefined
  return (
    <div
      className={cn(
        'rounded-md border px-2.5 py-1.5 text-[12px]',
        errorDetail
          ? 'border-destructive/30 bg-destructive/8'
          : score.pass === true
            ? 'border-[var(--color-success)]/30 bg-[var(--color-success)]/8'
            : score.pass === false
              ? 'border-destructive/30 bg-destructive/8'
              : 'border-border bg-muted/40'
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono">{score.metric}</span>
        <span className="tabular-nums">
          {score.value.toFixed(2)}
          {score.pass === true ? ' · ✓' : score.pass === false ? ' · ✗' : ''}
        </span>
      </div>
      {errorDetail ? (
        <pre className="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap rounded border border-destructive/20 bg-background/60 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-destructive">
          {errorDetail}
        </pre>
      ) : typeof score.detail === 'string' && score.detail ? (
        <p className="mt-0.5 text-muted-foreground">{score.detail}</p>
      ) : null}
    </div>
  )
}

// Judge run panel — pick a REAL trace from a connected observability platform, then EXECUTE the draft judge code
// against it (one sandboxed dispatch) and read the actual scores / crash output. No conversion-layer authoring
// here (that was the model-judge legacy): the code receives the normalized context as-is; a source-level mapping
// (if configured) applies server-side, and extracted evidence/snapshot relay silently into the run.
export function JudgePreviewPanel({
  getSpec,
  sources = [],
}: {
  getSpec: () => unknown
  sources?: TraceSourceConfig[]
  // kept for call-site compat; the run panel no longer authors per-harness mappings
  assignments?: Record<string, string>
}) {
  const t = useTranslations('judgePreview')
  const [step, setStep] = useState<Step>('pick')
  const [picked, setPicked] = useState<{ sourceName: string; summary: TraceSummary } | undefined>()
  const [inspected, setInspected] = useState<TraceInspectResult | undefined>()
  const [inspectError, setInspectError] = useState<string | undefined>()
  const [inspecting, startInspect] = useTransition()

  const { workspace } = useParams<{ workspace: string }>()
  const [task, setTask] = useState('')
  const [expected, setExpected] = useState('')
  const [result, setResult] = useState<TryJudgeResult | undefined>()
  const [runState, setRunState] = useState<JudgeTryRunState | undefined>()
  const [busy, start] = useTransition()

  const [timelineOpen, setTimelineOpen] = useState(false)

  // Inspect the picked trace once — the events (+ source-mapping-extracted evidence) the run will receive.
  useEffect(() => {
    if (!picked) return
    const { sourceName, summary } = picked
    startInspect(async () => {
      setInspectError(undefined)
      const res = await inspectTraceAction(sourceName, summary.id)
      if (res.ok) setInspected(res.result)
      else {
        setInspected(undefined)
        setInspectError(res.error)
      }
    })
  }, [picked])

  // Extracted browser evidence → the run's synthesized snapshot (same as the pull path).
  function evidenceSnapshot(): unknown | undefined {
    const ev = inspected?.evidence
    if (!ev) return undefined
    if (ev.dom === undefined && ev.screenshot === undefined && ev.screenshotRef === undefined)
      return undefined
    return {
      kind: 'browser',
      url: '',
      dom: ev.dom ?? '',
      ...(ev.screenshot ? { screenshot: ev.screenshot } : {}),
      ...(ev.screenshotRef ? { screenshotRef: ev.screenshotRef } : {}),
      console: [],
    }
  }

  function onRun() {
    setResult(undefined)
    setRunState(undefined)
    const trace = inspected?.events ?? []
    const snapshot = evidenceSnapshot()
    const traceEvidence = inspected?.evidence
    start(async () => {
      const res = await tryJudgeAction(getSpec(), trace, {
        ...(task.trim() ? { task: task.trim() } : {}),
        ...(expected.trim() ? { expected: expected.trim() } : {}),
        ...(snapshot ? { snapshot } : {}),
        ...(traceEvidence ? { traceEvidence } : {}),
      })
      setResult(res)
      if (res.ok && res.runId) setRunState({ ok: true, status: 'queued' })
    })
  }

  // The code dry-run is a REAL run — poll it until terminal so the user watches queued → running → verdict live.
  const trackedRunId = result?.ok ? result.runId : undefined
  useEffect(() => {
    if (!trackedRunId) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      const state = await judgeTryRunAction(trackedRunId)
      if (cancelled) return
      if (state.ok) setRunState(state)
      if (state.status === 'succeeded' || state.status === 'failed') return
      timer = setTimeout(tick, 2500)
    }
    timer = setTimeout(tick, 1200)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [trackedRunId])

  const runActive = Boolean(
    trackedRunId && runState?.status !== 'succeeded' && runState?.status !== 'failed'
  )
  // Verdict scores: inline (model judge) or read back from the promoted run — stamped with the production metric.
  const displayScores =
    result?.scores ??
    (runState?.status === 'succeeded' && runState.scores
      ? stampJudgeMetric(runState.scores, judgeIdOf(getSpec()))
      : undefined)

  const canRun = Boolean(picked)

  const runBody = (
    <>
      {/* Task / expected context (optional). */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="preview-task">{t('taskLabel')}</Label>
          <Input id="preview-task" value={task} onChange={(e) => setTask(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="preview-expected">{t('expectedLabel')}</Label>
          <Input
            id="preview-expected"
            value={expected}
            onChange={(e) => setExpected(e.target.value)}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={onRun} disabled={busy || runActive || !canRun} className="gap-1.5">
          {busy || runActive ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Play className="size-4" />
          )}
          {busy || runActive ? t('running') : t('runButton')}
        </Button>
        <span className="text-[12px] text-muted-foreground">{t('runHint')}</span>
      </div>

      {result && !result.ok ? <Callout tone="danger">{result.error ?? t('failed')}</Callout> : null}

      {/* The promoted run — live status while the sandboxed job progresses, with the full run detail one click away. */}
      {result?.ok && trackedRunId ? (
        <div className="space-y-2 rounded-lg border border-border bg-card/40 px-3 py-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-[12px]">
              {runActive ? (
                <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
              ) : runState?.status === 'succeeded' ? (
                <Check className="size-3.5 text-[var(--color-success)]" />
              ) : (
                <span className="size-2 rounded-full bg-destructive" />
              )}
              <span className="font-[510]">
                {runState?.status === 'running'
                  ? t('runRunning')
                  : runState?.status === 'succeeded'
                    ? t('runSucceeded')
                    : runState?.status === 'failed'
                      ? t('runFailed')
                      : t('runQueued')}
              </span>
              <span className="font-mono text-[11px] text-faint">{trackedRunId}</span>
            </div>
            <Link
              href={`/${workspace}/runs/${trackedRunId}`}
              target="_blank"
              className="flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground"
            >
              <ExternalLink className="size-3.5" />
              {t('viewRun')}
            </Link>
          </div>
          {runState?.status === 'failed' ? (
            <Callout tone="danger">{runState.failure ?? t('failed')}</Callout>
          ) : null}
          {runState?.logs ? (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded border border-border bg-background/60 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
              {runState.logs}
            </pre>
          ) : null}
        </div>
      ) : null}

      {result?.ok ? (
        <div className="space-y-3">
          {displayScores ? (
            <div className="space-y-1.5">
              <p className="text-[12px] font-medium text-muted-foreground">{t('scores')}</p>
              {displayScores.length === 0 ? (
                <p className="text-[12px] text-muted-foreground">{t('noScores')}</p>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {displayScores.map((s) => (
                    <ScoreRow key={s.metric} score={s} />
                  ))}
                </div>
              )}
            </div>
          ) : null}

          {result.warnings && result.warnings.length > 0 ? (
            <Callout tone="warning">
              <ul className="list-disc space-y-0.5 pl-4">
                {result.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </Callout>
          ) : null}
        </div>
      ) : null}
    </>
  )

  // No connected sources — nothing to pick, nothing to run against; point at the source registration.
  if (sources.length === 0) {
    return (
      <div className="space-y-3">
        <div>
          <h3 className="text-sm font-medium">{t('heading')}</h3>
          <p className="text-[12px] text-muted-foreground">{t('subtitle')}</p>
        </div>
        <Callout tone="info">{t('noSourcesNote')}</Callout>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium">{t('heading')}</h3>
          <p className="text-[12px] text-muted-foreground">{t('subtitle')}</p>
        </div>
        <StepRail step={step} picked={Boolean(picked)} canRun={canRun} onGo={(s) => setStep(s)} />
      </div>

      {/* Step 1 — pick a sample trace. Kept mounted (hidden) so list/filter state survives step hops. */}
      <div className={cn(step !== 'pick' && 'hidden')}>
        <TraceBrowser
          sources={sources}
          selectedTraceId={picked?.summary.id}
          onPick={(summary, sourceName) => {
            setPicked({ sourceName, summary })
            setResult(undefined)
            setStep('run')
          }}
        />
      </div>

      {/* Step 2 — execute the draft judge against the picked trace and read the real verdict / crash output. */}
      {step === 'run' && (
        <div className="space-y-3">
          {picked && (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card/40 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-[510]">
                  {picked.summary.name ?? picked.summary.id}
                </div>
                <div className="truncate font-mono text-[11px] text-faint">
                  {picked.summary.id} · {picked.sourceName}
                  {inspecting
                    ? ` · ${t('loadingEvents')}`
                    : inspected
                      ? ` · ${t('eventCount', { count: inspected.events.length })}`
                      : ''}
                </div>
              </div>
              <Button variant="secondary" size="sm" onClick={() => setStep('pick')}>
                {t('changeTrace')}
              </Button>
            </div>
          )}
          {inspectError && <Callout tone="danger">{inspectError}</Callout>}

          {/* What the code will receive — collapsible normalized timeline of the picked trace. */}
          {picked && inspected && inspected.events.length > 0 && (
            <div className="space-y-1.5">
              <button
                type="button"
                onClick={() => setTimelineOpen((o) => !o)}
                className="flex items-center gap-1 text-[12px] font-[510] text-muted-foreground hover:text-foreground"
              >
                {timelineOpen ? (
                  <ChevronDown className="size-3.5" />
                ) : (
                  <ChevronRight className="size-3.5" />
                )}
                {t('timelineHeading')}
              </button>
              {timelineOpen && (
                <div className="max-h-64 overflow-y-auto">
                  <TraceEventList events={inspected.events} />
                </div>
              )}
            </div>
          )}

          {runBody}
        </div>
      )}
    </div>
  )
}
