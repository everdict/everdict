'use client'

import { useState, useTransition } from 'react'
import { Pin } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { useRefresh } from '@/shared/lib/use-refresh'
import { Button } from '@/shared/ui/button'

import { repinHarnessAction } from '../api/repin-harness'

// Re-resolve the harness's moving image bindings into a NEW immutable version. The confirm says what it
// makes rather than asking "are you sure": a re-pin costs a version number, and a reader who thinks it
// edits the current one will use it very differently.
export function RepinHarnessButton({ id }: { id: string }) {
  const t = useTranslations('harnessesPage')
  const refresh = useRefresh()
  const [busy, start] = useTransition()
  const [message, setMessage] = useState<string>()
  const [error, setError] = useState<string>()

  function repin() {
    setError(undefined)
    setMessage(undefined)
    if (!window.confirm(t('repinConfirm'))) return
    start(async () => {
      const res = await repinHarnessAction(id)
      if (!res.ok) {
        setError(res.error ?? t('repinError'))
        return
      }
      // The new version is the whole outcome — a re-pin that says only "done" leaves a reader hunting the
      // version list for what just happened.
      setMessage(res.version !== undefined ? t('repinned', { version: res.version }) : t('repinnedNoChange'))
      refresh()
    })
  }

  return (
    <span className="inline-flex items-center gap-2">
      {error !== undefined && <span className="text-[12px] text-destructive">{error}</span>}
      {message !== undefined && <span className="text-[12px] text-muted-foreground">{message}</span>}
      <Button variant="outline" size="sm" onClick={repin} disabled={busy} title={t('repinTitle')}>
        <Pin className="size-4" /> {t('repin')}
      </Button>
    </span>
  )
}
