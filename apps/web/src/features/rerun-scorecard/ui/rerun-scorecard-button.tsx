'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, RotateCcw, X } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { JudgePicker, type JudgePickerChoice, type JudgeRef } from '@/entities/judge'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Combobox, type ComboboxOption } from '@/shared/ui/combobox'
import { Dialog } from '@/shared/ui/dialog'
import { Label } from '@/shared/ui/input'
import { InfoTip } from '@/shared/ui/tooltip'

import { rerunScorecardAction } from '../api/rerun-scorecard'

// Re-run action for a TERMINAL scorecard — one button, two scopes chosen in the dialog: a FULL re-run (every case,
// reproducing the original config) or a FAILED-only recovery (passing results carry over). For a full re-run the
// dialog surfaces the two run-config choices made at submit time — the selected judges and the execution runtime —
// pre-filled from the original batch and EDITABLE, so the user can adjust who runs it and re-run. Scoring (the
// grading plan / inline judge model / trace sink) is reproduced verbatim — a re-run adjusts WHO runs it, not HOW it's
// scored. A failed-only recovery keeps the original config as-is (carried-over cases stay consistent). On success we
// navigate to the fresh scorecard. The control plane enforces scorecards:run.
export function RerunScorecardButton({
  id,
  workspace,
  failedCount,
  originalJudges = [],
  originalRuntime,
  judges = [],
  runtimes = [],
  runners = [],
  hasWorkspaceRunners = false,
}: {
  id: string
  workspace: string
  failedCount: number // number of failed cases in the source batch — gates the "failed only" scope
  originalJudges?: JudgeRef[] // the batch's selected judges (prefill, versions pinned as they scored)
  originalRuntime?: string // the batch's execution target (prefill)
  judges?: JudgePickerChoice[] // registered Agent Judges available to pick, with their versions
  runtimes?: { id: string }[] // registered runtimes
  runners?: { id: string; label: string }[] // my personal runners
  hasWorkspaceRunners?: boolean // team shared runner pool available (self:ws)
}) {
  const t = useTranslations('rerunScorecard')
  const tr = useTranslations('runScorecard') // reuse the creation form's judge/runtime picker copy
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, start] = useTransition()
  const [scope, setScope] = useState<'all' | 'failed'>('all')
  // Prefilled with the batch's judges at their PINNED versions — an unchanged judge re-runs on the exact version
  // that scored; the picker lets each be re-versioned, and a newly-added judge defaults to latest.
  const [judgeRefs, setJudgeRefs] = useState<JudgeRef[]>(originalJudges)
  const [runtime, setRuntime] = useState(originalRuntime ?? '')
  const [error, setError] = useState<string>()
  const titleId = 'rerun-scorecard'
  // Runtime choices — registered runtimes + runner pools, same as the creation form. The original runtime is always
  // an option (even if it's since been removed) so the pre-filled value renders.
  const runtimeOptions = useMemo<ComboboxOption[]>(() => {
    const opts: ComboboxOption[] = [
      ...runtimes.map((r) => ({ value: r.id })),
      ...(hasWorkspaceRunners
        ? [{ value: 'self:ws', label: tr('poolWorkspaceLabel'), hint: tr('poolWorkspaceHint') }]
        : []),
      ...(runners.length > 0
        ? [{ value: 'self', label: tr('poolSelfLabel'), hint: tr('poolSelfHint') }]
        : []),
      ...runners.map((r) => ({ value: `self:${r.id}`, label: r.label, hint: tr('poolSelfHint') })),
    ]
    if (originalRuntime && !opts.some((o) => o.value === originalRuntime))
      opts.unshift({ value: originalRuntime })
    return opts
  }, [runtimes, runners, hasWorkspaceRunners, originalRuntime, tr])

  function close() {
    if (pending) return
    setOpen(false)
  }

  function submit() {
    setError(undefined)
    // Run-config edits apply to the full re-run only; a failed-only recovery reproduces the original config as-is.
    // Always send the (possibly-edited) list — an empty list re-runs with no judges.
    const overrides = scope === 'all' ? { judges: judgeRefs, ...(runtime ? { runtime } : {}) } : {}
    start(async () => {
      const res = await rerunScorecardAction({ id, scope, ...overrides })
      if (res.ok && res.id) router.push(`/${workspace}/scorecard/${res.id}`)
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

          {/* Run configuration — the judges + runtime this scorecard was run with, pre-filled and editable (full re-run
              only; a failed-only recovery reproduces the original config as-is). Scoring is reproduced verbatim. */}
          {scope === 'all' && (
            <div className="space-y-4 rounded-lg border bg-muted/20 px-4 py-3.5">
              <div className="flex items-center gap-1">
                <span className="text-[13px] font-[510] text-foreground">{t('configLegend')}</span>
                <InfoTip content={t('configNote')} />
              </div>

              {/* Selected judges — pre-filled from the original batch at their pinned versions; edit the set (or a
                  version) to score the re-run differently. */}
              <div className="space-y-1.5">
                <div className="flex items-center gap-1">
                  <Label htmlFor="rerun-judges">{tr('judgesLabel')}</Label>
                  <InfoTip content={tr('judgesTip')} />
                </div>
                <JudgePicker
                  id="rerun-judges"
                  judges={judges}
                  value={judgeRefs}
                  onChange={setJudgeRefs}
                />
              </div>

              {/* Execution runtime — pre-filled from the original batch; change where the re-run executes. */}
              <div className="space-y-1.5">
                <Label htmlFor="rerun-runtime">{tr('runtimeLabel')}</Label>
                <Combobox
                  id="rerun-runtime"
                  options={runtimeOptions}
                  value={runtime}
                  onChange={setRuntime}
                  placeholder={tr('runtimePlaceholder')}
                  emptyText={tr('runtimeEmpty')}
                />
              </div>
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
