'use client'

import { useId, useState } from 'react'
import { CalendarPlus } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { useRefresh } from '@/shared/lib/use-refresh'
import { Button } from '@/shared/ui/button'
import { Dialog } from '@/shared/ui/dialog'
import { Input } from '@/shared/ui/input'

import { createViewReportScheduleAction } from '../api/report-schedule-actions'

// Cadence presets — a report is a human rhythm (daily standup / Monday morning / monthly review), so the picker
// leads with those; "custom" opens a raw 5-field cron input for anything else.
const PRESETS = [
  { key: 'weekly', cron: '0 9 * * 1' },
  { key: 'daily', cron: '0 9 * * *' },
  { key: 'monthly', cron: '0 9 1 * *' },
  { key: 'custom', cron: '' },
] as const
type PresetKey = (typeof PRESETS)[number]['key']

export function NewReportScheduleDialog({ viewId }: { viewId: string }) {
  const t = useTranslations('viewReportSchedule')
  const refresh = useRefresh()
  const titleId = useId()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [preset, setPreset] = useState<PresetKey>('weekly')
  const [customCron, setCustomCron] = useState('0 9 * * 1')
  const [instructions, setInstructions] = useState('')
  const [compare, setCompare] = useState(true)
  const [error, setError] = useState<string | undefined>(undefined)
  const [pending, setPending] = useState(false)

  const cron = preset === 'custom' ? customCron : PRESETS.find((p) => p.key === preset)?.cron || ''

  const submit = () =>
    void (async () => {
      setPending(true)
      try {
        setError(undefined)
        const res = await createViewReportScheduleAction({
          viewId,
          name: name.trim(),
          cron,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
          ...(compare ? { compare: true } : {}),
        })
        if (!res.ok) {
          setError(res.error ?? t('actionFailed'))
          return
        }
        setOpen(false)
        setName('')
        setInstructions('')
        refresh()
      } finally {
        setPending(false)
      }
    })()

  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        <CalendarPlus className="size-4" /> {t('newSchedule')}
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} className="max-w-md" labelledBy={titleId}>
        <form
          className="space-y-4 p-5"
          onSubmit={(e) => {
            e.preventDefault()
            if (name.trim() && cron.trim()) submit()
          }}
        >
          <div className="space-y-1">
            <h2 id={titleId} className="text-sm font-semibold">
              {t('dialogTitle')}
            </h2>
            <p className="text-xs text-muted-foreground">{t('dialogDescription')}</p>
          </div>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">{t('nameLabel')}</span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('namePlaceholder')}
              maxLength={120}
              required
            />
          </label>

          <fieldset className="space-y-1.5">
            <legend className="text-xs font-medium text-muted-foreground">
              {t('cadenceLabel')}
            </legend>
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((p) => (
                <Button
                  key={p.key}
                  type="button"
                  size="sm"
                  variant={preset === p.key ? 'primary' : 'secondary'}
                  onClick={() => setPreset(p.key)}
                >
                  {t(`preset_${p.key}`)}
                </Button>
              ))}
            </div>
            {preset === 'custom' && (
              <Input
                value={customCron}
                onChange={(e) => setCustomCron(e.target.value)}
                placeholder="0 9 * * 1"
                aria-label={t('cronLabel')}
                required
              />
            )}
          </fieldset>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              {t('instructionsLabel')}
            </span>
            <textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder={t('instructionsPlaceholder')}
              maxLength={4000}
              rows={3}
              className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
            />
          </label>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={compare}
              onChange={(e) => setCompare(e.target.checked)}
              className="size-4 accent-[var(--color-primary)]"
            />
            {t('compareLabel')}
          </label>

          {error && <p className="text-xs text-destructive">{error}</p>}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              {t('cancel')}
            </Button>
            <Button type="submit" disabled={pending || !name.trim() || !cron.trim()}>
              {pending ? t('creating') : t('create')}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  )
}
