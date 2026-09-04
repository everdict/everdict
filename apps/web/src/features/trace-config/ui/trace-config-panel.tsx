'use client'

import { useState, useTransition } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { useRefresh } from '@/shared/lib/use-refresh'
import { Button } from '@/shared/ui/button'

import { setTraceIngestionAction, setTraceThresholdsAction } from '../api/trace-config'
import {
  TRACE_THRESHOLD_METRICS,
  type TraceIngestion,
  type TraceThreshold,
} from '../api/trace-config-shapes'

// The two settings every trajectory is measured against, edited where they are read. Admin-only at the
// control plane; the panel renders read-only for everyone else rather than offering controls that 403.
export function TraceConfigPanel({
  thresholds: initial,
  ingestion,
  canWrite,
  error,
}: {
  thresholds?: TraceThreshold[]
  ingestion?: TraceIngestion
  canWrite: boolean
  error?: string
}) {
  const t = useTranslations('observabilityPage')
  const refresh = useRefresh()
  const [rows, setRows] = useState<TraceThreshold[]>(initial ?? [])
  const [cap, setCap] = useState(ingestion?.maxEventsPerHour ?? null)
  const [busy, start] = useTransition()
  const [failure, setFailure] = useState<string>()

  // A read that FAILED is not an empty configuration. Saying "no thresholds" over an unreadable store tells
  // a member nothing is being watched, which is the one wrong answer this panel can give.
  if (error !== undefined) return <p className="text-[12px] text-destructive">{t('configUnread', { error })}</p>

  const save = () => {
    setFailure(undefined)
    start(async () => {
      const a = await setTraceThresholdsAction(rows)
      const b = await setTraceIngestionAction(cap)
      if (a.ok && b.ok) refresh()
      else setFailure(a.error ?? b.error ?? t('configSaveError'))
    })
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        {rows.map((row, i) => (
          <div key={`${row.name}-${i}`} className="flex items-center gap-2">
            <input
              value={row.name}
              disabled={!canWrite}
              onChange={(e) => setRows(rows.map((r, j) => (i === j ? { ...r, name: e.target.value } : r)))}
              className="h-8 min-w-0 flex-1 rounded-md border border-border/60 bg-transparent px-2 text-[13px]"
            />
            <select
              value={row.metric}
              disabled={!canWrite}
              onChange={(e) =>
                setRows(rows.map((r, j) => (i === j ? { ...r, metric: e.target.value as TraceThreshold['metric'] } : r)))
              }
              className="h-8 rounded-md border border-border/60 bg-transparent px-2 text-[13px]"
            >
              {TRACE_THRESHOLD_METRICS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <input
              type="number"
              value={row.value}
              disabled={!canWrite}
              onChange={(e) =>
                setRows(rows.map((r, j) => (i === j ? { ...r, value: Number(e.target.value) } : r)))
              }
              className="h-8 w-28 rounded-md border border-border/60 bg-transparent px-2 text-[13px]"
            />
            {canWrite && (
              <Button variant="ghost" size="sm" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                <Trash2 className="size-4" />
              </Button>
            )}
          </div>
        ))}
        {rows.length === 0 && <p className="text-[12px] text-muted-foreground">{t('noThresholds')}</p>}
        {canWrite && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setRows([...rows, { name: '', metric: 'usd', value: 0 }])}
          >
            <Plus className="size-4" /> {t('addThreshold')}
          </Button>
        )}
      </div>

      <div className="flex items-center gap-2 border-t pt-3">
        <span className="text-[12px] text-muted-foreground">{t('ingestionCap')}</span>
        <input
          type="number"
          // EMPTY means NO CEILING, and that is a different setting from a large number — the wire carries
          // `null` for it rather than a sentinel, and this input keeps the two apart.
          value={cap ?? ''}
          placeholder={t('noCeiling')}
          disabled={!canWrite}
          onChange={(e) => setCap(e.target.value === '' ? null : Number(e.target.value))}
          className="h-8 w-40 rounded-md border border-border/60 bg-transparent px-2 text-[13px]"
        />
        {ingestion?.usedThisHour !== undefined && (
          <span className="text-[12px] text-faint">{t('usedThisHour', { used: ingestion.usedThisHour })}</span>
        )}
      </div>

      {failure !== undefined && <p className="text-[12px] text-destructive">{failure}</p>}
      {canWrite && (
        <Button size="sm" onClick={save} disabled={busy}>
          {t('saveConfig')}
        </Button>
      )}
    </div>
  )
}
