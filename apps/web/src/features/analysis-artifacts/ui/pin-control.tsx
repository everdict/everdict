'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Pin, PinOff } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import type { AnalysisArtifact } from '@/entities/analysis-artifact'
import { viewsSchema, type View } from '@/entities/view'
import { DropdownItem, DropdownLabel, DropdownMenu } from '@/shared/ui/dropdown-menu'

// Pin/unpin a conversation artifact onto a View — the artifact's creator curates which outputs graduate from
// the conversation into the View's gallery. The view roster loads lazily on first open (visible views only —
// the same list the control plane returns for the views page).
export function PinControl({ artifact }: { artifact: AnalysisArtifact }) {
  const t = useTranslations('analysisArtifacts')
  const router = useRouter()
  const [views, setViews] = useState<View[] | null>(null)
  const [busy, setBusy] = useState(false)

  const loadViews = async () => {
    if (views !== null) return
    try {
      const res = await fetch('/api/views', { cache: 'no-store' })
      if (!res.ok) throw new Error('load failed')
      setViews(viewsSchema.parse(await res.json()))
    } catch {
      setViews([])
    }
  }

  const pin = async (viewId: string) => {
    setBusy(true)
    try {
      const res = await fetch(`/api/agent/artifacts/${encodeURIComponent(artifact.id)}/pin`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ viewId }),
      })
      if (!res.ok) throw new Error('pin failed')
      toast.success(t('pinned'))
      router.refresh()
    } catch {
      toast.error(t('pinFailed'))
    } finally {
      setBusy(false)
    }
  }

  const unpin = async () => {
    setBusy(true)
    try {
      const res = await fetch(`/api/agent/artifacts/${encodeURIComponent(artifact.id)}/pin`, {
        method: 'DELETE',
      })
      if (!res.ok) throw new Error('unpin failed')
      toast.success(t('unpinned'))
      router.refresh()
    } catch {
      toast.error(t('pinFailed'))
    } finally {
      setBusy(false)
    }
  }

  if (artifact.pinned) {
    return (
      <button
        type="button"
        disabled={busy}
        aria-label={t('unpin')}
        title={t('unpin')}
        onClick={() => void unpin()}
        className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
      >
        <PinOff className="size-3.5" />
      </button>
    )
  }

  return (
    <DropdownMenu
      align="end"
      trigger={({ toggle, open }) => (
        <button
          type="button"
          disabled={busy}
          aria-label={t('pinTo')}
          title={t('pinTo')}
          aria-expanded={open}
          onClick={() => {
            void loadViews()
            toggle()
          }}
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          <Pin className="size-3.5" />
        </button>
      )}
    >
      <DropdownLabel>{t('pinTo')}</DropdownLabel>
      {views === null ? (
        <p className="px-3 py-1.5 text-xs text-muted-foreground">{t('loadingViews')}</p>
      ) : views.length === 0 ? (
        <p className="px-3 py-1.5 text-xs text-muted-foreground">{t('noViews')}</p>
      ) : (
        views.map((v) => (
          <DropdownItem key={v.id} onSelect={() => void pin(v.id)}>
            {v.name}
          </DropdownItem>
        ))
      )}
    </DropdownMenu>
  )
}
