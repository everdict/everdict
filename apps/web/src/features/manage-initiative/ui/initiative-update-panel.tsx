'use client'

import { useState } from 'react'
import { Loader2, Megaphone } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { HealthPicker, type TrackerHealth } from '@/entities/tracker-health'
import { useRefresh } from '@/shared/lib/use-refresh'
import { Button } from '@/shared/ui/button'
import { Textarea } from '@/shared/ui/input'

import { postInitiativeUpdateAction } from '../api/initiatives'

// The place where a PERSON says where the goal is now. The arithmetic (progress) is counted by the server, but "so is it all right" is a
// JUDGEMENT, so the verdict and its sentence live in one form — the server refuses a verdict with no body too.
export function InitiativeUpdatePanel({ id }: { id: string }) {
  const t = useTranslations('initiativesPage')
  const refresh = useRefresh()
  const [health, setHealth] = useState<TrackerHealth>('on_track')
  const [body, setBody] = useState('')
  const [pending, setPending] = useState(false)

  function submit() {
    const trimmed = body.trim()
    if (trimmed.length === 0) return
    void (async () => {
      setPending(true)
      try {
        const r = await postInitiativeUpdateAction(id, { health, body: trimmed })
        if (!r.ok) {
          toast.error(r.error ?? t('updateError'))
          return
        }
        setBody('')
        refresh()
      } finally {
        setPending(false)
      }
    })()
  }

  return (
    <form
      className="space-y-2 rounded-lg border bg-card p-3 shadow-raise"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <HealthPicker value={health} onChange={setHealth} />
      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={t('updatePlaceholder')}
        rows={3}
      />
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={pending || body.trim().length === 0}>
          {pending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Megaphone className="size-3.5" />
          )}
          {t('postUpdate')}
        </Button>
      </div>
    </form>
  )
}
