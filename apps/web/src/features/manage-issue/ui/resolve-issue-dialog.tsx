'use client'

import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { Button } from '@/shared/ui/button'
import { Combobox } from '@/shared/ui/combobox'
import { Dialog } from '@/shared/ui/dialog'
import { Label, Textarea } from '@/shared/ui/input'
import { InfoTip } from '@/shared/ui/tooltip'

export interface ResolvableScorecard {
  id: string
  label: string
}

// Closing an issue records HOW it was evaluated — the scorecard is the evidence, and it doubles as the
// baseline a later regression is measured against. That is why `done` is a dialog and not a menu item.
export function ResolveIssueDialog({
  open,
  onClose,
  onResolve,
  pending,
  scorecards,
}: {
  open: boolean
  onClose: () => void
  onResolve: (resolution: { scorecardId?: string; note?: string }) => void
  pending: boolean
  scorecards: ResolvableScorecard[]
}) {
  const t = useTranslations('issuesPage')
  const [scorecardId, setScorecardId] = useState('')
  const [note, setNote] = useState('')

  return (
    <Dialog open={open} onClose={onClose} className="max-w-lg">
      <form
        className="space-y-4 p-5"
        onSubmit={(e) => {
          e.preventDefault()
          onResolve({
            ...(scorecardId ? { scorecardId } : {}),
            ...(note.trim() ? { note: note.trim() } : {}),
          })
        }}
      >
        <div className="flex items-center gap-1.5">
          <h2 className="text-[15px] font-[560] text-foreground">{t('resolveTitle')}</h2>
          <InfoTip content={t('resolveTip')} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="resolve-scorecard">{t('resolveScorecard')}</Label>
          <Combobox
            id="resolve-scorecard"
            value={scorecardId}
            onChange={setScorecardId}
            searchable
            placeholder={t('resolveScorecardNone')}
            options={[
              { value: '', label: t('resolveScorecardNone') },
              ...scorecards.map((s) => ({ value: s.id, label: s.label })),
            ]}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="resolve-note">{t('resolveNote')}</Label>
          <Textarea
            id="resolve-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t('resolveNotePlaceholder')}
          />
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? <Loader2 className="size-3.5 animate-spin" /> : t('resolveConfirm')}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
