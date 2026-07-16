'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'

import { membersSchema } from '@/entities/member'
import { queueSnapshotSchema, type QueueSnapshot } from '@/entities/queue'

// Shared work-widget state — the collapsed summary pill (top-right cluster) and the expanded docking rail (a sibling
// of main) live at different DOM locations yet must share the same open state and the same polling snapshot, so it is
// lifted into context (one poll refreshes both). Data is client polling of GET /queue (BFF /api/queue) — slow when
// closed / fast when open, skipped while the tab is hidden.

export type WorkAuthor = { name: string; avatarUrl?: string }

type WorkPanelValue = {
  workspace: string
  open: boolean
  setOpen: (v: boolean) => void
  toggle: () => void
  snapshot: QueueSnapshot | null
  authors: Record<string, WorkAuthor>
}

const WorkPanelContext = createContext<WorkPanelValue | null>(null)

const POLL_OPEN_MS = 4_000 // when open — live progress
const POLL_CLOSED_MS = 20_000 // when closed — only refresh the summary counts

export function WorkPanelProvider({
  workspace,
  children,
}: {
  workspace: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [snapshot, setSnapshot] = useState<QueueSnapshot | null>(null)
  const [authors, setAuthors] = useState<Record<string, WorkAuthor>>({})
  const authorsLoaded = useRef(false)

  const poll = useCallback(async () => {
    try {
      const res = await fetch('/api/queue', { cache: 'no-store' })
      if (!res.ok) return
      const parsed = queueSnapshotSchema.safeParse(await res.json())
      if (parsed.success) setSnapshot(parsed.data)
    } catch {
      // Poll failures stay silent — retried on the next cycle.
    }
  }, [])

  // Poll — once immediately on mount and whenever open changes, then periodically (fast open / slow closed). Skip while the tab is hidden.
  useEffect(() => {
    void poll()
    const timer = setInterval(
      () => {
        if (typeof document !== 'undefined' && document.hidden) return
        void poll()
      },
      open ? POLL_OPEN_MS : POLL_CLOSED_MS
    )
    const onFocus = () => void poll()
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [poll, open])

  // Authors (name/avatar) — lazy-loaded only on the rail's first open (so we don't add a member lookup to every page).
  useEffect(() => {
    if (!open || authorsLoaded.current) return
    authorsLoaded.current = true
    void (async () => {
      try {
        const res = await fetch('/api/members', { cache: 'no-store' })
        if (!res.ok) return
        const parsed = membersSchema.safeParse(await res.json())
        if (!parsed.success) return
        const map: Record<string, WorkAuthor> = {}
        for (const m of parsed.data)
          map[m.subject] = {
            name: m.name ?? m.email?.split('@')[0] ?? m.subject,
            ...(m.avatarUrl ? { avatarUrl: m.avatarUrl } : {}),
          }
        setAuthors(map)
      } catch {
        // Ignore an author-enrichment failure — fall back to showing the subject.
      }
    })()
  }, [open])

  // Close with Esc.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const toggle = useCallback(() => setOpen((v) => !v), [])

  return (
    <WorkPanelContext.Provider value={{ workspace, open, setOpen, toggle, snapshot, authors }}>
      {children}
    </WorkPanelContext.Provider>
  )
}

export function useWorkPanel(): WorkPanelValue {
  const ctx = useContext(WorkPanelContext)
  if (!ctx) throw new Error('useWorkPanel must be used within WorkPanelProvider')
  return ctx
}
