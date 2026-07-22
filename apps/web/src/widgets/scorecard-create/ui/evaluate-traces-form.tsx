'use client'

import { useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Telescope, X } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { TraceBrowser, type TraceSelection } from '@/features/browse-traces'
import { evaluateTracesAction } from '@/features/ingest-scorecard'
import type { TraceSummary } from '@/entities/trace'
import type { TraceSourceConfig } from '@/entities/trace-source'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Combobox } from '@/shared/ui/combobox'
import { EmptyState } from '@/shared/ui/empty-state'
import { Label } from '@/shared/ui/input'
import { InfoTip } from '@/shared/ui/tooltip'

// Pick a set of already-produced traces from a workspace trace source and run judges over them — NO dataset, NO harness
// run (the "evaluate existing traces" scorecard). Each selected trace becomes one case. The selection is bound to a
// SINGLE source (pull-ingest pulls from one source); switching source starts a fresh selection.
export function EvaluateTracesForm({
  judges,
  traceSources,
}: {
  judges: { id: string }[]
  traceSources: TraceSourceConfig[]
}) {
  const t = useTranslations('evaluateTraces')
  const router = useRouter()
  const { workspace } = useParams<{ workspace: string }>()
  const [sel, setSel] = useState<{ sourceName: string; ids: Set<string> } | null>(null)
  const [judgeIds, setJudgeIds] = useState<string[]>([])
  const [serverError, setServerError] = useState<string>()
  const [busy, setBusy] = useState(false)

  // The whole selection lives on one source (pull-ingest = one source). A toggle from a different source resets it.
  const toggle = (tr: TraceSummary, sourceName: string) =>
    setSel((prev) => {
      if (!prev || prev.sourceName !== sourceName) return { sourceName, ids: new Set([tr.id]) }
      const ids = new Set(prev.ids)
      if (ids.has(tr.id)) ids.delete(tr.id)
      else ids.add(tr.id)
      return ids.size === 0 ? null : { sourceName, ids }
    })
  const selection: TraceSelection = { selected: sel?.ids ?? new Set<string>(), onToggle: toggle }
  const count = sel?.ids.size ?? 0

  async function onSubmit() {
    if (!sel || sel.ids.size === 0) {
      setServerError(t('noTraces'))
      return
    }
    setBusy(true)
    setServerError(undefined)
    const res = await evaluateTracesAction({
      sourceName: sel.sourceName,
      traceIds: [...sel.ids],
      judgeIds,
    })
    setBusy(false)
    if (res.ok && res.id) router.push(`/${workspace}/scorecards/${res.id}`)
    else setServerError(res.error ?? t('submitError'))
  }

  if (traceSources.length === 0) {
    return (
      <EmptyState
        icon={<Telescope className="size-5" />}
        title={t('noSourcesTitle')}
        hint={t('noSourcesHint')}
      />
    )
  }

  const available = judges.filter((j) => !judgeIds.includes(j.id)).map((j) => ({ value: j.id }))

  return (
    <div className="space-y-5">
      <TraceBrowser sources={traceSources} selection={selection} />

      {/* Judges + submit bar. */}
      <div className="space-y-4 rounded-lg border border-border bg-card p-4">
        <div className="space-y-1.5">
          <div className="flex items-center gap-1">
            <Label htmlFor="eval-judges">{t('judgesLabel')}</Label>
            <InfoTip content={t('judgesTip')} />
          </div>
          <Combobox
            id="eval-judges"
            options={available}
            value=""
            onChange={(v) => {
              if (v && !judgeIds.includes(v)) setJudgeIds([...judgeIds, v])
            }}
            placeholder={t('judgesPlaceholder')}
            emptyText={t('judgesEmpty')}
          />
          {judgeIds.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {judgeIds.map((id) => (
                <span
                  key={id}
                  className="inline-flex items-center gap-1 rounded bg-secondary px-2 py-0.5 font-mono text-[12px] font-[510] text-secondary-foreground ring-1 ring-inset ring-border"
                >
                  {id}
                  <button
                    type="button"
                    aria-label={t('judgesRemove', { id })}
                    onClick={() => setJudgeIds(judgeIds.filter((x) => x !== id))}
                    className="text-faint transition-colors hover:text-destructive"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <p className="text-[12px] text-muted-foreground">{t('judgesHelp')}</p>
        </div>

        {serverError && <Callout tone="danger">{serverError}</Callout>}

        <div className="flex items-center justify-between">
          <p className="text-[12px] text-muted-foreground">
            {count > 0 ? t('selectedCount', { count }) : t('selectHint')}
          </p>
          <Button type="button" onClick={onSubmit} disabled={busy || count === 0}>
            {busy ? t('submitting') : t('submit')}
          </Button>
        </div>
      </div>
    </div>
  )
}
