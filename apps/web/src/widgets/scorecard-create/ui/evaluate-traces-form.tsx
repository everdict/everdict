'use client'

import { useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Telescope } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { TraceBrowser, type TraceSelection } from '@/features/browse-traces'
import { evaluateTracesAction } from '@/features/ingest-scorecard'
import { JudgePicker, type JudgePickerChoice, type JudgeRef } from '@/entities/judge'
import type { TraceSummary } from '@/entities/trace'
import type { TraceSourceConfig } from '@/entities/trace-source'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { Label } from '@/shared/ui/input'
import { InfoTip } from '@/shared/ui/tooltip'

// Pick a set of already-produced traces from a workspace trace source and run judges over them — NO dataset, NO harness
// run (the "evaluate existing traces" scorecard). Each selected trace becomes one case. The selection is bound to a
// SINGLE source (pull-ingest pulls from one source); switching source starts a fresh selection.
export function EvaluateTracesForm({
  judges,
  traceSources,
  teamId,
}: {
  judges: JudgePickerChoice[]
  traceSources: TraceSourceConfig[]
  teamId?: string
}) {
  const t = useTranslations('evaluateTraces')
  const router = useRouter()
  const { workspace } = useParams<{ workspace: string }>()
  const [sel, setSel] = useState<{ sourceName: string; ids: Set<string> } | null>(null)
  const [judgeRefs, setJudgeRefs] = useState<JudgeRef[]>([])
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
      judges: judgeRefs,
      ...(teamId ? { teamId } : {}),
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

  return (
    <div className="space-y-5">
      <TraceBrowser sources={traceSources} selection={selection} />

      {/* Judges + submit bar. Each selected judge carries its own version (default latest). */}
      <div className="space-y-4 rounded-lg border border-border bg-card p-4">
        <div className="space-y-1.5">
          <div className="flex items-center gap-1">
            <Label htmlFor="eval-judges">{t('judgesLabel')}</Label>
            <InfoTip content={t('judgesTip')} />
          </div>
          <JudgePicker id="eval-judges" judges={judges} value={judgeRefs} onChange={setJudgeRefs} />
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
