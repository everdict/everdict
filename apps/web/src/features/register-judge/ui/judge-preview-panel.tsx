'use client'

import { useEffect, useState, useTransition } from 'react'
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Play,
  ShieldCheck,
} from 'lucide-react'
import { useTranslations } from 'next-intl'

import { inspectTraceAction, TraceBrowser, TraceEventList } from '@/features/browse-traces'
import type { TraceInspectResult, TraceSummary } from '@/entities/trace'
import type { TraceSourceConfig } from '@/entities/trace-source'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Input, Label, Textarea } from '@/shared/ui/input'

import { tryJudgeAction, type JudgeScore, type TryJudgeResult } from '../api/register-judge'

type Step = 'pick' | 'run'

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

  const [task, setTask] = useState('')
  const [expected, setExpected] = useState('')
  const [result, setResult] = useState<TryJudgeResult | undefined>()
  const [parseError, setParseError] = useState<string | undefined>()
  const [busy, start] = useTransition()

  const [timelineOpen, setTimelineOpen] = useState(false)
  const [manualOpen, setManualOpen] = useState(false)
  const [manualTrace, setManualTrace] = useState('')

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

  // The trace fed to the run: the manual JSON (advanced, when filled) overrides; else the inspected events.
  function effectiveTrace(): unknown | undefined {
    setParseError(undefined)
    setResult(undefined)
    if (manualTrace.trim()) {
      try {
        return JSON.parse(manualTrace)
      } catch {
        setParseError(t('invalidTrace'))
        return undefined
      }
    }
    return inspected?.events ?? []
  }

  // Extracted browser evidence → the run's synthesized snapshot (same as the pull path); manual JSON carries none.
  function evidenceSnapshot(): unknown | undefined {
    const ev = inspected?.evidence
    if (!ev || manualTrace.trim()) return undefined
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
    const trace = effectiveTrace()
    if (trace === undefined) return
    const snapshot = evidenceSnapshot()
    const traceEvidence = manualTrace.trim() ? undefined : inspected?.evidence
    start(async () =>
      setResult(
        await tryJudgeAction(getSpec(), trace, {
          ...(task.trim() ? { task: task.trim() } : {}),
          ...(expected.trim() ? { expected: expected.trim() } : {}),
          ...(snapshot ? { snapshot } : {}),
          ...(traceEvidence ? { traceEvidence } : {}),
        })
      )
    )
  }

  const canRun = Boolean(picked) || manualTrace.trim().length > 0

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
        <Button onClick={onRun} disabled={busy || !canRun} className="gap-1.5">
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
          {busy ? t('running') : t('runButton')}
        </Button>
        <span className="text-[12px] text-muted-foreground">{t('runHint')}</span>
      </div>

      {/* Advanced: paste a raw TraceEvent[] JSON instead (overrides the picked trace). */}
      <div className="space-y-2">
        <button
          type="button"
          onClick={() => setManualOpen((o) => !o)}
          className="flex items-center gap-1 text-[12px] font-[510] text-muted-foreground hover:text-foreground"
        >
          {manualOpen ? (
            <ChevronDown className="size-3.5" />
          ) : (
            <ChevronRight className="size-3.5" />
          )}
          {t('manualHeading')}
          {!manualOpen && manualTrace.trim() ? <span className="text-primary">•</span> : null}
        </button>
        {manualOpen && (
          <div className="space-y-1.5">
            <Textarea
              value={manualTrace}
              onChange={(e) => setManualTrace(e.target.value)}
              placeholder={t('tracePlaceholder')}
              rows={5}
              className="font-mono text-[12px]"
            />
            <p className="text-[12px] text-muted-foreground">{t('manualHint')}</p>
          </div>
        )}
      </div>

      {parseError ? <Callout tone="danger">{parseError}</Callout> : null}
      {result && !result.ok ? <Callout tone="danger">{result.error ?? t('failed')}</Callout> : null}

      {result?.ok ? (
        <div className="space-y-3">
          {result.scores ? (
            <div className="space-y-1.5">
              <p className="text-[12px] font-medium text-muted-foreground">{t('scores')}</p>
              {result.scores.length === 0 ? (
                <p className="text-[12px] text-muted-foreground">{t('noScores')}</p>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {result.scores.map((s) => (
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

          {/* Declared-requirement check — which of the judge's `requires` this trace satisfies. */}
          {result.requirements ? (
            <div className="space-y-1.5">
              <p className="flex items-center gap-1 text-[12px] font-medium text-muted-foreground">
                <ShieldCheck className="size-3.5" />
                {t('requirements')}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {result.requirements.satisfied.map((r, i) => (
                  <span
                    key={`ok-${i}-${r.kind}`}
                    className="rounded-md border border-[var(--color-success)]/30 bg-[var(--color-success)]/8 px-2 py-0.5 text-[12px] text-[var(--color-success)]"
                  >
                    ✓ {r.kind}
                    {r.name ? `:${r.name}` : r.role ? `:${r.role}` : ''}
                  </span>
                ))}
                {result.requirements.missing.map((r, i) => (
                  <span
                    key={`no-${i}-${r.kind}`}
                    className="rounded-md border border-destructive/30 bg-destructive/8 px-2 py-0.5 text-[12px] text-destructive"
                  >
                    ✗ {r.kind}
                    {r.name ? `:${r.name}` : r.role ? `:${r.role}` : ''}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  )

  // No connected sources — nothing to pick; run against a pasted trace only.
  if (sources.length === 0) {
    return (
      <div className="space-y-3">
        <div>
          <h3 className="text-sm font-medium">{t('heading')}</h3>
          <p className="text-[12px] text-muted-foreground">{t('subtitle')}</p>
        </div>
        <Callout tone="info">{t('noSourcesNote')}</Callout>
        {runBody}
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
      <div className={cn('space-y-2', step !== 'pick' && 'hidden')}>
        <TraceBrowser
          sources={sources}
          selectedTraceId={picked?.summary.id}
          onPick={(summary, sourceName) => {
            setPicked({ sourceName, summary })
            setResult(undefined)
            setStep('run')
          }}
        />
        <button
          type="button"
          onClick={() => {
            setManualOpen(true)
            setStep('run')
          }}
          className="text-[12px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          {t('skipToManual')}
        </button>
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

          <div className="border-t border-border/60 pt-3">
            <Button variant="ghost" size="sm" onClick={() => setStep('pick')} className="gap-1">
              <ChevronLeft className="size-4" />
              {t('back')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
