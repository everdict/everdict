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

// Infra split-view state — the screen splits into an eval side (left: routed pages) and an infra side (right:
// the floating panel). The panel hosts the REAL routed infra pages (schedules / runtimes / runs) in same-origin
// iframes with their own history — full existing screens, fully independent navigation — plus the purpose-built
// work tab (queue snapshot). The vertical rail (divider) and the panel share this context; it is mounted once
// in the [workspace] shell, so left-side navigation never interrupts anything playing on the right.

export type WorkAuthor = { name: string; avatarUrl?: string }

export type InfraTab = 'schedules' | 'runtimes' | 'runs' | 'work'

// A deep-open request into a page tab's iframe — e.g. openRun() points the runs tab at that run's REAL detail
// page. seq forces re-application even for a repeated identical target (the user may have navigated away inside
// the iframe in between).
export type FrameRequest = { tab: InfraTab; path: string; seq: number }

type InfraPanelValue = {
  workspace: string
  open: boolean
  tab: InfraTab
  // Rail button semantics — same tab while open = collapse; otherwise open on that tab.
  toggleTab: (tab: InfraTab) => void
  // Non-toggling open (command palette, deep entries) — always ends open on the given tab.
  openTab: (tab: InfraTab) => void
  close: () => void
  // Deep entries — open the panel on a tab AND point its iframe at the real page for the entity.
  openRun: (id: string) => void
  openRuntime: (kind: 'runtime' | 'runner', id: string) => void
  openSchedule: (id: string) => void
  frameRequest: FrameRequest | null
  snapshot: QueueSnapshot | null
  authors: Record<string, WorkAuthor>
}

const InfraPanelContext = createContext<InfraPanelValue | null>(null)

const POLL_OPEN_MS = 4_000 // when open — live progress
const POLL_CLOSED_MS = 20_000 // when closed — only refresh the rail badge counts

export function InfraPanelProvider({
  workspace,
  children,
}: {
  workspace: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<InfraTab>('work')
  const [frameRequest, setFrameRequest] = useState<FrameRequest | null>(null)
  const frameSeq = useRef(0)
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

  // Authors (name/avatar) — lazy-loaded only on the panel's first open (so we don't add a member lookup to every page).
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

  const toggleTab = useCallback(
    (next: InfraTab) => {
      if (open && tab === next) setOpen(false)
      else {
        setTab(next)
        setOpen(true)
      }
    },
    [open, tab]
  )

  const openTab = useCallback((next: InfraTab) => {
    setTab(next)
    setOpen(true)
  }, [])

  const close = useCallback(() => setOpen(false), [])

  const request = useCallback((target: InfraTab, path: string) => {
    frameSeq.current += 1
    setFrameRequest({ tab: target, path, seq: frameSeq.current })
    setTab(target)
    setOpen(true)
  }, [])

  const openRun = useCallback(
    (id: string) => request('runs', `/runs/${encodeURIComponent(id)}`),
    [request]
  )

  const openRuntime = useCallback(
    (kind: 'runtime' | 'runner', id: string) =>
      request(
        'runtimes',
        kind === 'runner'
          ? `/runtimes/self/${encodeURIComponent(id)}`
          : `/runtimes/${encodeURIComponent(id)}`
      ),
    [request]
  )

  // The schedules surface is the list page (no per-schedule route) — open it; the id stays for a future anchor.
  const openSchedule = useCallback((_id: string) => request('schedules', '/schedules'), [request])

  return (
    <InfraPanelContext.Provider
      value={{
        workspace,
        open,
        tab,
        toggleTab,
        openTab,
        close,
        openRun,
        openRuntime,
        openSchedule,
        frameRequest,
        snapshot,
        authors,
      }}
    >
      {children}
    </InfraPanelContext.Provider>
  )
}

export function useInfraPanel(): InfraPanelValue {
  const ctx = useContext(InfraPanelContext)
  if (!ctx) throw new Error('useInfraPanel must be used within InfraPanelProvider')
  return ctx
}
