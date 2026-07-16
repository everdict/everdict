'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { ChevronDown, ChevronRight, Eye, Loader2, Play, Save } from 'lucide-react'
import { useTranslations } from 'next-intl'

import {
  inspectTraceAction,
  saveHarnessSpanMappingAction,
  TraceBrowser,
} from '@/features/browse-traces'
import {
  EMPTY_SPAN_MAPPING,
  mappingRecordToSpec,
  SpanMappingEditor,
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

// Live judge preview — pick a real trace from a connected observability platform, author the span→TraceEvent conversion
// (span-based kinds) against it, and see the EXACT judging prompt / evidence / (with Run once) real scores. getSpec()
// reads the current form spec on demand so rubric edits reflect on the next Preview/Run. Byte-identical to a real grade.
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

  const rawAttrKeys = useMemo(() => {
    const keys = new Set<string>()
    for (const s of inspected?.rawAttributes ?? [])
      for (const k of Object.keys(s.attrs)) keys.add(k)
    return [...keys].sort()
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

  const meta = () => ({
    ...(task.trim() ? { task: task.trim() } : {}),
    ...(expected.trim() ? { expected: expected.trim() } : {}),
  })

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

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-medium">{t('heading')}</h3>
        <p className="text-[12px] text-muted-foreground">{t('subtitle')}</p>
      </div>

      {sources.length > 0 ? (
        <div className="space-y-3 rounded-lg border border-border bg-card/40 p-3">
          <p className="text-[12px] font-medium text-muted-foreground">{t('pickTrace')}</p>
          <TraceBrowser
            sources={sources}
            selectedTraceId={picked?.summary.id}
            onPick={(summary, sourceName) => setPicked({ sourceName, summary })}
          />
        </div>
      ) : (
        <Callout tone="info">{t('noSourcesNote')}</Callout>
      )}

      {picked && (
        <div className="space-y-3 rounded-lg border border-border bg-card/40 p-3">
          <p className="text-[12px] font-medium text-muted-foreground">
            {t('conversion')} ·{' '}
            <span className="font-mono text-foreground/80">{picked.summary.id}</span>
          </p>
          {isSpanKind ? (
            <SpanMappingEditor
              mapping={mappingRec}
              onChange={setMappingRec}
              rawAttrKeys={rawAttrKeys}
            />
          ) : (
            <Callout tone="info">{t('nativeKindNote')}</Callout>
          )}
          {inspectError && <Callout tone="danger">{inspectError}</Callout>}
          <p className="text-[12px] text-muted-foreground">
            {inspecting
              ? t('converting')
              : t('convertedEvents', { count: inspected?.events.length ?? 0 })}
          </p>

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
        </div>
      )}

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
    </div>
  )
}
