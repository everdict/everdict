'use client'

import { useState, useTransition } from 'react'
import { Copy, KeyRound } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { useRefresh } from '@/shared/lib/use-refresh'
import { Button } from '@/shared/ui/button'

import { mintPushGrantAction, mirrorImageAction } from '../api/image-actions'

// The two member actions the managed image store had and the web did not: bring an external image IN, and
// mint the credential that pushes one. Both gated on `images:push` at the control plane.
export function ImageStoreActions({ canPush }: { canPush: boolean }) {
  const t = useTranslations('workspaceImages')
  const refresh = useRefresh()
  const [image, setImage] = useState('')
  const [busy, start] = useTransition()
  const [error, setError] = useState<string>()
  const [grant, setGrant] = useState<string>()

  if (!canPush) return null

  return (
    <div className="space-y-3 border-t pt-4">
      <div className="flex items-center gap-2">
        <input
          value={image}
          onChange={(e) => setImage(e.target.value)}
          placeholder={t('mirrorPlaceholder')}
          className="h-8 min-w-0 flex-1 rounded-md border border-border/60 bg-transparent px-2 text-[13px]"
        />
        <Button
          variant="outline"
          size="sm"
          disabled={busy || image.trim() === ''}
          title={t('mirrorTitle')}
          onClick={() => {
            setError(undefined)
            start(async () => {
              const res = await mirrorImageAction(image.trim())
              if (res.ok) {
                setImage('')
                refresh()
              } else setError(res.error ?? t('mirrorError'))
            })
          }}
        >
          <Copy className="size-4" /> {t('mirror')}
        </Button>
      </div>

      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={busy || image.trim() === ''}
          title={t('pushGrantTitle')}
          onClick={() => {
            setError(undefined)
            setGrant(undefined)
            start(async () => {
              const res = await mintPushGrantAction(image.trim())
              if (res.ok) setGrant(res.detail ?? '')
              else setError(res.error ?? t('pushGrantError'))
            })
          }}
        >
          <KeyRound className="size-4" /> {t('pushGrant')}
        </Button>
        {/* Shown ONCE, here, and never stored: the credential is handed back to the caller and the web is
            not a place to keep it. A page that saved it would be a second copy nobody asked for. */}
        {grant !== undefined && (
          <code className="min-w-0 flex-1 truncate rounded border border-border bg-muted/40 px-2 py-1 font-mono text-[11px]">
            {grant}
          </code>
        )}
      </div>

      {error !== undefined && <p className="text-[12px] text-destructive">{error}</p>}
    </div>
  )
}
