'use client'

import { useState, useTransition } from 'react'
import { Camera, Clock, GitPullRequest } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { useRefresh } from '@/shared/lib/use-refresh'
import { Button } from '@/shared/ui/button'

import {
  pushSandboxGitAction,
  snapshotSandboxAction,
  touchSandboxAction,
} from '../api/sandbox-session'

// The three acts that make a live session worth keeping open. Shown only while it IS live: a closed
// session's keep-alive is a control that can only answer 409.
export function SandboxSessionActions({ id, live }: { id: string; live: boolean }) {
  const t = useTranslations('sandboxSession')
  const refresh = useRefresh()
  const [busy, start] = useTransition()
  const [detail, setDetail] = useState<string>()
  const [error, setError] = useState<string>()

  if (!live) return null

  const run = (fn: () => Promise<{ ok: boolean; detail?: string; error?: string }>, fallback: string) => {
    setError(undefined)
    setDetail(undefined)
    start(async () => {
      const res = await fn()
      if (!res.ok) {
        setError(res.error ?? fallback)
        return
      }
      // The thing it MADE is the outcome. "Done" leaves nobody able to reference the version that was just
      // minted or find the pull request that was just opened.
      if (res.detail !== undefined) setDetail(res.detail)
      refresh()
    })
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant="ghost"
        size="sm"
        disabled={busy}
        title={t('keepAliveTitle')}
        onClick={() => run(() => touchSandboxAction(id), t('keepAliveError'))}
      >
        <Clock className="size-4" /> {t('keepAlive')}
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        title={t('snapshotTitle')}
        onClick={() => {
          // A snapshot mints an immutable world version other cases can reference — it is not a save
          // button, and the confirm says which of the two it is.
          if (!window.confirm(t('snapshotConfirm'))) return
          run(() => snapshotSandboxAction(id), t('snapshotError'))
        }}
      >
        <Camera className="size-4" /> {t('snapshot')}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={busy}
        title={t('pushTitle')}
        onClick={() => {
          const pr = window.confirm(t('pushAsPr'))
          run(() => pushSandboxGitAction(id, pr), t('pushError'))
        }}
      >
        <GitPullRequest className="size-4" /> {t('push')}
      </Button>
      {detail !== undefined && <span className="font-mono text-[11.5px] text-muted-foreground">{detail}</span>}
      {error !== undefined && <span className="text-[12px] text-destructive">{error}</span>}
    </div>
  )
}
