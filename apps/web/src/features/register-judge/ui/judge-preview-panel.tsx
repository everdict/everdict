'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Eye,
  Loader2,
  Play,
  Save,
} from 'lucide-react'
import { useTranslations } from 'next-intl'

import {
  inspectTraceAction,
  saveHarnessSpanMappingAction,
  TraceBrowser,
  TraceEventList,
} from '@/features/browse-traces'
import {
  EMPTY_SPAN_MAPPING,
  mappingRecordToSpec,
  SpanMappingEditor,
  type SpanAttrOption,
  type SpanMappingRecord,
  type TraceInspectResult,
  type TraceSummary,
} from '@/entities/trace'
import type { TraceSourceConfig } from '@/entities/trace-source'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Combobox } from '@/shared/ui/combobox'
import { Input, Label, Textarea } from '@/shared/ui/input'

import { previewJudgeAction, tryJudgeAction, type TryJudgeResult } from '../api/register-judge'

const SPAN_KINDS = new Set(['otel', 'mlflow'])

type Step = 'pick' | 'convert' | 'preview'

// One sample value per observed attribute key — so the conversion builder shows what each key actually holds.
function sampleStr(v: unknown): string {
  if (typeof v === 'string') return v.length > 80 ? `${v.slice(0, 80)}…` : v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  try {
    return (JSON.stringify(v) ?? String(v)).slice(0, 80)
  } catch {
    return String(v)
  }
}

// The wizard's step rail — reachable steps are clickable, the completed pick shows a check.
function StepRail({
  step,
  picked,
  canPreview,
  onGo,
}: {
  step: Step
  picked: boolean
  canPreview: boolean
  onGo: (s: Step) => void
}) {
  const t = useTranslations('judgePreview')
  const items: { id: Step; label: string; enabled: boolean; done: boolean }[] = [
    { id: 'pick', label: t('stepPick'), enabled: true, done: picked && step !== 'pick' },
    { id: 'convert', label: t('stepConvert'), enabled: picked, done: false },
    { id: 'preview', label: t('stepPreview'), enabled: canPreview, done: false },
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

// Live judge preview — a 3-step flow: ① pick a real sample trace from a connected observability platform
// (list → detail dialog with prev/next → "Use this trace"), ② author the span→TraceEvent conversion against it
// with the mouse-only mapping builder (the list stays out of the way), ③ see the EXACT judging prompt / evidence /
// (with Run once) real scores. getSpec() reads the current form spec on demand so rubric edits reflect on the next
// Preview/Run. Byte-identical to a real grade.
export function JudgePreviewPanel({
  getSpec,
  sources = [],
  assignments = {},
}: {
  getSpec: () => unknown
  sources?: TraceSourceConfig[]
  assignments?: Record<string, string>
}) {
  const t = useTranslations('judgePreview')
  const [step, setStep] = useState<Step>('pick')
  const [picked, setPicked] = useState<{ sourceName: string; summary: TraceSummary } | undefined>()
  const [mappingRec, setMappingRec] = useState<SpanMappingRecord>(EMPTY_SPAN_MAPPING)
  const [inspected, setInspected] = useState<TraceInspectResult | undefined>()
  const [inspectError, setInspectError] = useState<string | undefined>()
  const [inspecting, startInspect] = useTransition()

  const [saveHarness, setSaveHarness] = useState('')
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; error?: string } | undefined>()
  const [saving, startSave] = useTransition()

  const [task, setTask] = useState('')
  const [expected, setExpected] = useState('')
  const [result, setResult] = useState<TryJudgeResult | undefined>()
  const [parseError, setParseError] = useState<string | undefined>()
  const [busy, start] = useTransition()

  const [manualOpen, setManualOpen] = useState(false)
  const [manualTrace, setManualTrace] = useState('')

  const pickedSource = useMemo(
    () => sources.find((s) => s.name === picked?.sourceName),
    [sources, picked?.sourceName]
  )
  const isSpanKind = pickedSource ? SPAN_KINDS.has(pickedSource.kind) : false
  const mappingSpec = useMemo(() => mappingRecordToSpec(mappingRec), [mappingRec])

  // Reverse-lookup: harnesses that pull from the picked source — the natural target(s) to save the conversion onto.
  const assignedHarnesses = useMemo(
    () =>
      Object.entries(assignments)
        .filter(([, name]) => name === picked?.sourceName)
        .map(([h]) => h),
    [assignments, picked?.sourceName]
  )
  useEffect(() => {
    setSaveHarness(assignedHarnesses[0] ?? '')
    setSaveMsg(undefined)
  }, [assignedHarnesses])

  // Re-inspect the picked trace whenever the trace or the (span-based) mapping changes — the live conversion loop.
  useEffect(() => {
    if (!picked) return
    const traceId = picked.summary.id
    const sourceName = picked.sourceName
    const spec = isSpanKind ? mappingSpec : undefined
    const timer = setTimeout(() => {
      startInspect(async () => {
        setInspectError(undefined)
        const res = await inspectTraceAction(sourceName, traceId, spec)
        if (res.ok) setInspected(res.result)
        else {
          setInspected(undefined)
          setInspectError(res.error)
        }
      })
    }, 300)
    return () => clearTimeout(timer)
  }, [picked, mappingSpec, isSpanKind])

  // The observed attribute keys + one sample value each — what the mouse-only mapping builder offers per field.
  const attrOptions = useMemo<SpanAttrOption[]>(() => {
    const seen = new Map<string, string>()
    for (const s of inspected?.rawAttributes ?? [])
      for (const [k, v] of Object.entries(s.attrs)) if (!seen.has(k)) seen.set(k, sampleStr(v))
    return [...seen.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, sample]) => ({ key, sample }))
  }, [inspected])

  // The trace fed to preview/try: the manual JSON (advanced, when filled) overrides; else the inspected events.
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

  // The wizard-side mirror of the pull path's snapshot synthesis: extracted browser evidence (dom/screenshot)
  // becomes the preview's browser snapshot, so dom/screenshot coverage and VLM "Run once" work on pulled traces.
  // A manual JSON override carries no evidence — no snapshot then.
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

  const meta = () => {
    const snapshot = evidenceSnapshot()
    return {
      ...(task.trim() ? { task: task.trim() } : {}),
      ...(expected.trim() ? { expected: expected.trim() } : {}),
      ...(snapshot ? { snapshot } : {}),
    }
  }

  function onPreview() {
    const trace = effectiveTrace()
    if (trace === undefined) return
    start(async () => setResult(await previewJudgeAction(getSpec(), trace, meta())))
  }
  function onTry() {
    const trace = effectiveTrace()
    if (trace === undefined) return
    start(async () => setResult(await tryJudgeAction(getSpec(), trace, meta())))
  }

  function onSaveMapping() {
    if (!saveHarness.trim()) return
    startSave(async () => {
      const res = await saveHarnessSpanMappingAction(saveHarness.trim(), mappingSpec ?? null)
      setSaveMsg(res.ok ? { ok: true } : { ok: false, error: res.error })
    })
  }

  const canRun = Boolean(picked) || manualTrace.trim().length > 0

  // Shared by the stepper's preview step and the no-sources fallback (manual JSON only).
  const previewBody = (
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
        <Button
          variant="secondary"
          onClick={onPreview}
          disabled={busy || !canRun}
          className="gap-1.5"
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Eye className="size-4" />}
          {t('previewButton')}
        </Button>
        <Button variant="ghost" onClick={onTry} disabled={busy || !canRun} className="gap-1.5">
          <Play className="size-4" />
          {t('tryButton')}
        </Button>
        <span className="text-[12px] text-muted-foreground">{t('tryHint')}</span>
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
                    <div
                      key={s.metric}
                      className={cn(
                        'rounded-md border px-2.5 py-1.5 text-[12px]',
                        s.pass === true
                          ? 'border-[var(--color-success)]/30 bg-[var(--color-success)]/8'
                          : s.pass === false
                            ? 'border-destructive/30 bg-destructive/8'
                            : 'border-border bg-muted/40'
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono">{s.metric}</span>
                        <span className="tabular-nums">
                          {s.value.toFixed(2)}
                          {s.pass === true ? ' · ✓' : s.pass === false ? ' · ✗' : ''}
                        </span>
                      </div>
                      {typeof s.detail === 'string' && s.detail ? (
                        <p className="mt-0.5 text-muted-foreground">{s.detail}</p>
                      ) : null}
                    </div>
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

          {result.evidence ? (
            <div>
              <p className="mb-1.5 text-[12px] font-medium text-muted-foreground">
                {t('coverage')}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(result.evidence).map(([key, c]) => (
                  <span
                    key={key}
                    className={cn(
                      'rounded-md border px-2 py-0.5 text-[12px]',
                      c.present
                        ? c.truncated
                          ? 'border-[var(--color-warning)]/30 bg-[var(--color-warning)]/8 text-[var(--color-warning)]'
                          : 'border-primary/25 bg-primary/6 text-foreground'
                        : 'border-border bg-muted/50 text-muted-foreground line-through'
                    )}
                    title={c.present ? t('chars', { n: c.chars }) : t('absent')}
                  >
                    {key}
                    {c.truncated ? ` · ${t('truncated')}` : ''}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          {result.requirements ? (
            <div className="space-y-1.5">
              <p className="text-[12px] font-medium text-muted-foreground">{t('requirements')}</p>
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

          {result.prompt ? (
            <div>
              <p className="mb-1.5 text-[12px] font-medium text-muted-foreground">
                {t('renderedPrompt')}
              </p>
              <pre className="max-h-80 overflow-auto rounded-lg border bg-muted/40 p-3 text-[12px] leading-relaxed whitespace-pre-wrap">
                {result.prompt}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  )

  // No connected sources — no trace to pick or convert; fall back to the manual-JSON preview only.
  if (sources.length === 0) {
    return (
      <div className="space-y-3">
        <div>
          <h3 className="text-sm font-medium">{t('heading')}</h3>
          <p className="text-[12px] text-muted-foreground">{t('subtitle')}</p>
        </div>
        <Callout tone="info">{t('noSourcesNote')}</Callout>
        {previewBody}
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
        <StepRail
          step={step}
          picked={Boolean(picked)}
          canPreview={canRun}
          onGo={(s) => setStep(s)}
        />
      </div>

      {/* Step 1 — pick a sample trace. Kept mounted (hidden) so list/filter state survives step hops. */}
      <div className={cn('space-y-2', step !== 'pick' && 'hidden')}>
        <TraceBrowser
          sources={sources}
          selectedTraceId={picked?.summary.id}
          onPick={(summary, sourceName) => {
            setPicked({ sourceName, summary })
            setStep('convert')
          }}
        />
        <button
          type="button"
          onClick={() => {
            setManualOpen(true)
            setStep('preview')
          }}
          className="text-[12px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          {t('skipToManual')}
        </button>
      </div>

      {/* Step 2 — the conversion layer, authored against the picked trace (the list stays hidden). */}
      {step === 'convert' && picked && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card/40 px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-[510]">
                {picked.summary.name ?? picked.summary.id}
              </div>
              <div className="truncate font-mono text-[11px] text-faint">
                {picked.summary.id} · {picked.sourceName}
                {pickedSource ? ` (${pickedSource.kind})` : ''}
              </div>
            </div>
            <Button variant="secondary" size="sm" onClick={() => setStep('pick')}>
              {t('changeTrace')}
            </Button>
          </div>

          {isSpanKind ? (
            <SpanMappingEditor
              mapping={mappingRec}
              onChange={setMappingRec}
              attrs={attrOptions}
              evidence={inspected?.evidence}
            />
          ) : (
            <Callout tone="info">{t('nativeKindNote')}</Callout>
          )}
          {inspectError && <Callout tone="danger">{inspectError}</Callout>}

          {/* The live conversion result — exactly the events the judge will see, re-normalized on every click. */}
          <div className="space-y-1.5">
            <p className="text-[12px] font-medium text-muted-foreground">
              {inspecting
                ? t('converting')
                : t('convertedEvents', { count: inspected?.events.length ?? 0 })}
            </p>
            {inspected && (
              <div className="max-h-64 overflow-y-auto">
                <TraceEventList events={inspected.events} />
              </div>
            )}
          </div>

          {/* Save the authored conversion onto a harness (member+). */}
          {isSpanKind && mappingSpec && (
            <div className="flex flex-wrap items-end gap-2 border-t border-border/60 pt-3">
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-[510] text-muted-foreground">
                  {t('saveToHarness')}
                </span>
                {assignedHarnesses.length > 0 ? (
                  <Combobox
                    options={assignedHarnesses.map((h) => ({ value: h }))}
                    value={saveHarness}
                    onChange={setSaveHarness}
                    className="w-56"
                    aria-label={t('saveToHarness')}
                  />
                ) : (
                  <Input
                    value={saveHarness}
                    onChange={(e) => setSaveHarness(e.target.value)}
                    placeholder={t('harnessIdPlaceholder')}
                    className="w-56 font-mono text-[12px]"
                  />
                )}
              </label>
              <Button
                variant="secondary"
                onClick={onSaveMapping}
                disabled={saving || !saveHarness.trim()}
                className="gap-1.5"
              >
                {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                {t('saveMapping')}
              </Button>
              {saveMsg?.ok && (
                <span className="pb-1.5 text-[12px] text-[var(--color-success)]">{t('saved')}</span>
              )}
              {saveMsg && !saveMsg.ok && (
                <span className="pb-1.5 text-[12px] text-destructive">{saveMsg.error}</span>
              )}
            </div>
          )}

          <div className="flex items-center justify-between border-t border-border/60 pt-3">
            <Button variant="ghost" size="sm" onClick={() => setStep('pick')} className="gap-1">
              <ChevronLeft className="size-4" />
              {t('back')}
            </Button>
            <Button size="sm" onClick={() => setStep('preview')} className="gap-1">
              {t('nextPreview')}
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Step 3 — preview / run against the converted (or pasted) trace. */}
      {step === 'preview' && (
        <div className="space-y-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setStep(picked ? 'convert' : 'pick')}
            className="gap-1"
          >
            <ChevronLeft className="size-4" />
            {t('back')}
          </Button>
          {previewBody}
        </div>
      )}
    </div>
  )
}
