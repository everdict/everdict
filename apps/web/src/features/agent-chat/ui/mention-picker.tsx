'use client'

import { useEffect, useState } from 'react'
import {
  Boxes,
  ClipboardCheck,
  Database,
  Eye,
  Play,
  Scale,
  Server,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useTranslations } from 'next-intl'

import {
  AGENT_REFERENCE_TYPES,
  type AgentReference,
  type AgentReferenceType,
} from '@/entities/agent-session'

export const REFERENCE_TYPE_ICON: Record<AgentReferenceType, LucideIcon> = {
  harness: Boxes,
  runtime: Server,
  run: Play,
  dataset: Database,
  scorecard: ClipboardCheck,
  judge: Scale,
  view: Eye,
}

interface MentionItem {
  id: string
  label: string
  version?: string
}

// A reference shown as a chip — in the composer (removable) and in the transcript (read-only).
export function ReferenceChip({
  reference,
  onRemove,
}: {
  reference: AgentReference
  onRemove?: () => void
}) {
  const t = useTranslations('agentChat')
  const Icon = REFERENCE_TYPE_ICON[reference.type]
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-md border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[11px] text-foreground">
      <Icon className="size-3 shrink-0 text-primary" />
      <span className="text-faint">{t(`refType.${reference.type}`)}</span>
      <span className="truncate font-mono">{reference.label}</span>
      {onRemove && (
        <button
          type="button"
          aria-label={t('mentionRemove')}
          onClick={onRemove}
          className="shrink-0 text-muted-foreground hover:text-destructive"
        >
          <X className="size-3" />
        </button>
      )}
    </span>
  )
}

// The @-mention popover: pick an entity type, then an instance. Selecting an instance calls onPick with the
// resolved reference. Fetches candidates from the BFF (/api/agent/mentions/<type>).
export function MentionPicker({
  onPick,
  onClose,
}: {
  onPick: (reference: AgentReference) => void
  onClose: () => void
}) {
  const t = useTranslations('agentChat')
  const [type, setType] = useState<AgentReferenceType | null>(null)
  const [items, setItems] = useState<MentionItem[]>([])
  const [loading, setLoading] = useState(false)
  const [q, setQ] = useState('')

  useEffect(() => {
    if (!type) return
    let cancelled = false
    setLoading(true)
    void (async () => {
      try {
        const res = await fetch(`/api/agent/mentions/${type}`, { cache: 'no-store' })
        const data = res.ok ? await res.json() : { items: [] }
        if (!cancelled) setItems(Array.isArray(data.items) ? data.items : [])
      } catch {
        if (!cancelled) setItems([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [type])

  const filtered = q
    ? items.filter(
        (it) =>
          it.id.toLowerCase().includes(q.toLowerCase()) ||
          it.label.toLowerCase().includes(q.toLowerCase())
      )
    : items

  return (
    <div className="absolute bottom-full left-0 right-0 z-10 mb-1 max-h-72 overflow-hidden rounded-lg border border-border bg-popover shadow-pop">
      <div className="flex items-center justify-between border-b border-border px-2 py-1.5">
        <span className="text-[12px] font-[560] text-foreground">
          {type ? t(`refType.${type}`) : t('mentionPick')}
        </span>
        <button
          type="button"
          aria-label={t('mentionClose')}
          onClick={type ? () => setType(null) : onClose}
          className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>

      {!type ? (
        <ul className="max-h-60 overflow-y-auto p-1">
          {AGENT_REFERENCE_TYPES.map((rt) => {
            const Icon = REFERENCE_TYPE_ICON[rt]
            return (
              <li key={rt}>
                <button
                  type="button"
                  onClick={() => {
                    setQ('')
                    setType(rt)
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-accent"
                >
                  <Icon className="size-4 shrink-0 text-muted-foreground/70" />
                  {t(`refType.${rt}`)}
                </button>
              </li>
            )
          })}
        </ul>
      ) : (
        <div className="flex max-h-64 flex-col">
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('mentionSearch')}
            className="m-1 rounded border border-border bg-background px-2 py-1 text-[12.5px] outline-none focus:border-primary/50"
          />
          <ul className="min-h-0 flex-1 overflow-y-auto p-1">
            {loading ? (
              <li className="px-2 py-2 text-[12px] text-muted-foreground">{t('mentionLoading')}</li>
            ) : filtered.length === 0 ? (
              <li className="px-2 py-2 text-[12px] text-muted-foreground">{t('mentionEmpty')}</li>
            ) : (
              filtered.map((it) => (
                <li key={`${it.id}@${it.version ?? ''}`}>
                  <button
                    type="button"
                    onClick={() =>
                      onPick({
                        type,
                        id: it.id,
                        ...(it.version ? { version: it.version } : {}),
                        label: it.label,
                      })
                    }
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent"
                  >
                    <span className="truncate font-mono text-[12.5px] text-foreground">
                      {it.label}
                    </span>
                    {it.version && (
                      <span className="shrink-0 text-[11px] text-faint">v{it.version}</span>
                    )}
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </div>
  )
}
