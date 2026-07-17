'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, RotateCcw, X } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Combobox } from '@/shared/ui/combobox'
import { Dialog } from '@/shared/ui/dialog'
import { Label, Textarea } from '@/shared/ui/input'
import { InfoTip } from '@/shared/ui/tooltip'

import { rerunScorecardAction } from '../api/rerun-scorecard'

// Parse the optional grading-plan JSON — empty is ok (no override). Must be a non-empty array of { id }.
function parseGraders(
  text: string
): { ok: true; graders?: { id: string; config?: Record<string, unknown> }[] } | { ok: false } {
  const t = text.trim()
  if (!t) return { ok: true }
  let parsed: unknown
  try {
    parsed = JSON.parse(t)
  } catch {
    return { ok: false }
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return { ok: false }
  const graders: { id: string; config?: Record<string, unknown> }[] = []
  for (const g of parsed) {
    if (typeof g !== 'object' || g === null || typeof (g as { id?: unknown }).id !== 'string')
      return { ok: false }
    const o = g as { id: string; config?: unknown }
    graders.push({
      id: o.id,
      ...(o.config && typeof o.config === 'object' && !Array.isArray(o.config)
        ? { config: o.config as Record<string, unknown> }
        : {}),
    })
  }
  return { ok: true, graders }
}

// Re-run action for a TERMINAL scorecard — one button, two scopes chosen in the dialog: a FULL re-run (every case,
// original config, optionally re-scored with a different grading plan / judge model / trace sink) or a FAILED-only
// recovery (passing results carry over). The advanced re-score overrides live here (not in the creation wizard) —
// re-scoring differently is inherently a re-run concern, and they apply to the full scope only (a failed-only
// recovery keeps the original scoring so the carried-over cases stay consistent). On success we navigate to the
// fresh scorecard. The control plane enforces scorecards:run.
export function RerunScorecardButton({
  id,
  workspace,
  failedCount,
  sinks = [],
  models = [],
}: {
  id: string
  workspace: string
  failedCount: number // number of failed cases in the source batch — gates the "failed only" scope
  sinks?: { name: string; kind: string }[] // configured workspace trace sinks (per-batch export override)
  models?: { id: string }[] // registered models (inline judge scoring-model override)
}) {
  const t = useTranslations('rerunScorecard')
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, start] = useTransition()
  const [scope, setScope] = useState<'all' | 'failed'>('all')
  const [advanced, setAdvanced] = useState(false)
  const [traceSink, setTraceSink] = useState('')
  const [judgeModel, setJudgeModel] = useState('')
  const [gradersJson, setGradersJson] = useState('')
  const [error, setError] = useState<string>()
  const titleId = 'rerun-scorecard'

  function close() {
    if (pending) return
    setOpen(false)
  }

  function submit() {
    setError(undefined)
    // Overrides apply to the full re-run only; a failed-only recovery keeps the original scoring.
    let graders: { id: string; config?: Record<string, unknown> }[] | undefined
    if (scope === 'all') {
      const parsed = parseGraders(gradersJson)
      if (!parsed.ok) {
        setError(t('gradersInvalid'))
        return
      }
      graders = parsed.graders
    }
    start(async () => {
      const res = await rerunScorecardAction({
        id,
        scope,
        ...(scope === 'all'
          ? {
              ...(graders ? { graders } : {}),
              ...(traceSink ? { traceSink } : {}),
              ...(judgeModel ? { judgeModel } : {}),
            }
          : {}),
      })
      if (res.ok && res.id) router.push(`/${workspace}/scorecards/${res.id}`)
      else setError(res.error ?? t('error'))
    })
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <RotateCcw className="size-4" />
        {t('button')}
      </Button>

      <Dialog open={open} onClose={close} className="max-w-lg" labelledBy={titleId}>
        <div className="flex items-start gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-[14px] font-[560] tracking-[-0.01em] text-foreground">
              {t('title')}
            </h2>
            <p className="mt-0.5 text-[12.5px] text-muted-foreground">{t('description')}</p>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label={t('close')}
            className="-mr-1 -mt-1 grid size-7 shrink-0 place-items-center rounded-md text-faint transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          {/* Scope — full re-run vs failed-only recovery. "실패만" is offered only when the source has failed cases. */}
          <fieldset className="space-y-2" aria-label={t('scopeLegend')}>
            <ScopeOption
              selected={scope === 'all'}
              onSelect={() => setScope('all')}
              title={t('scopeAllLabel')}
              hint={t('scopeAllHint')}
            />
            <ScopeOption
              selected={scope === 'failed'}
              onSelect={() => setScope('failed')}
              disabled={failedCount === 0}
              title={t('scopeFailedLabel')}
              hint={
                failedCount === 0
                  ? t('scopeFailedNone')
                  : t('scopeFailedHint', { count: failedCount })
              }
            />
          </fieldset>

          {/* Advanced re-score overrides — full re-run only (a failed recovery keeps the original scoring). */}
          {scope === 'all' && (
            <div className="rounded-lg border bg-muted/20">
              <button
                type="button"
                onClick={() => setAdvanced((v) => !v)}
                className="flex w-full items-center justify-between px-4 py-2.5 text-[13px] font-[510] text-foreground"
              >
                {t('advancedToggle')}
                <span className="text-faint">{advanced ? '−' : '+'}</span>
              </button>
              {advanced && (
                <div className="space-y-4 border-t px-4 py-3.5">
                  <p className="text-[12px] text-muted-foreground">{t('overridesNote')}</p>
                  {/* Per-batch trace-sink override — a configured workspace sink, or 'none' to suppress export. */}
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-1">
                      <Label htmlFor="rerun-traceSink">{t('traceSinkLabel')}</Label>
                      <InfoTip content={t('traceSinkTip')} />
                    </div>
                    <Combobox
                      id="rerun-traceSink"
                      options={[
                        { value: '', label: t('traceSinkDefault') },
                        { value: 'none', label: t('traceSinkNone') },
                        ...sinks.map((s) => ({ value: s.name, label: `${s.name} (${s.kind})` })),
                      ]}
                      value={traceSink}
                      onChange={setTraceSink}
                      searchable={false}
                    />
                  </div>

                  {/* Inline judge scoring-model override — a registered Model id for the inline judge grader. */}
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-1">
                      <Label htmlFor="rerun-judgeModel">{t('judgeModelLabel')}</Label>
                      <InfoTip content={t('judgeModelTip')} />
                    </div>
                    <Combobox
                      id="rerun-judgeModel"
                      options={[
                        { value: '', label: t('judgeModelDefault') },
                        ...models.map((m) => ({ value: m.id })),
                      ]}
                      value={judgeModel}
                      onChange={setJudgeModel}
                      placeholder={t('judgeModelDefault')}
                      emptyText={t('judgeModelEmpty')}
                    />
                  </div>

                  {/* Grading-plan override — a GraderSpec[] JSON that replaces every case's default graders. */}
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-1">
                      <Label htmlFor="rerun-gradersJson">{t('gradersLabel')}</Label>
                      <InfoTip content={t('gradersTip')} />
                    </div>
                    <Textarea
                      id="rerun-gradersJson"
                      rows={4}
                      className="font-mono text-[12px]"
                      placeholder={t('gradersPlaceholder')}
                      value={gradersJson}
                      onChange={(e) => setGradersJson(e.target.value)}
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          {error && <Callout tone="danger">{error}</Callout>}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3.5">
          <Button variant="ghost" size="sm" onClick={close} disabled={pending}>
            {t('cancel')}
          </Button>
          <Button size="sm" onClick={submit} disabled={pending}>
            {pending && <Loader2 className="size-3.5 animate-spin" />}
            {pending ? t('submitting') : t('button')}
          </Button>
        </div>
      </Dialog>
    </>
  )
}

// One selectable scope row — a radio-style card carrying a title + explanatory hint (disabled when unavailable).
function ScopeOption({
  selected,
  onSelect,
  disabled = false,
  title,
  hint,
}: {
  selected: boolean
  onSelect: () => void
  disabled?: boolean
  title: string
  hint: string
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        'flex w-full items-start gap-3 rounded-lg border px-3.5 py-3 text-left transition-colors',
        disabled
          ? 'cursor-not-allowed border-border bg-muted/20 opacity-60'
          : selected
            ? 'border-primary bg-primary/5'
            : 'border-border hover:bg-accent'
      )}
    >
      <span
        className={cn(
          'mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border',
          selected ? 'border-primary' : 'border-border'
        )}
      >
        {selected && <span className="size-2 rounded-full bg-primary" />}
      </span>
      <span className="min-w-0 space-y-0.5">
        <span className="block text-[13px] font-[510] text-foreground">{title}</span>
        <span className="block text-[12px] leading-relaxed text-muted-foreground">{hint}</span>
      </span>
    </button>
  )
}
