'use client'

import { useState, useTransition } from 'react'
import { Trash2 } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { useRefresh } from '@/shared/lib/use-refresh'
import { Button } from '@/shared/ui/button'

import { clearWorkspaceFsAction } from '../api/clear-workspace-fs'

// Empty the whole tree. Admin-only, and the confirm asks for the WORKSPACE NAME rather than a yes: this
// deletes every member's files, not the caller's, and a yes/no dialog is the wrong shape for an act whose
// blast radius is other people's work.
export function ClearWorkspaceFsButton({ workspace, canClear }: { workspace: string; canClear: boolean }) {
  const t = useTranslations('files')
  const refresh = useRefresh()
  const [busy, start] = useTransition()
  const [error, setError] = useState<string>()

  if (!canClear) return null

  return (
    <span className="inline-flex items-center gap-2">
      {error !== undefined && <span className="text-[12px] text-destructive">{error}</span>}
      <Button
        variant="ghost"
        size="sm"
        disabled={busy}
        title={t('clearTitle')}
        onClick={() => {
          setError(undefined)
          const typed = window.prompt(t('clearPrompt', { workspace }))
          // Typing the workspace name is the confirmation. Anything else — including a cancel — leaves the
          // tree alone, because a mistyped name is exactly the case this guard exists for.
          if (typed === null || typed.trim() !== workspace) return
          start(async () => {
            const res = await clearWorkspaceFsAction()
            if (res.ok) refresh()
            else setError(res.error ?? t('clearError'))
          })
        }}
      >
        <Trash2 className="size-4" /> {t('clear')}
      </Button>
    </span>
  )
}
