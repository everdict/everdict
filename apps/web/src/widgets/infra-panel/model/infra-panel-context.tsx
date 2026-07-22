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
// the floating panel with schedules / runtimes / runs / work). The vertical rail (the divider device) and the
// panel live at different DOM locations yet share the open state, the active tab, the selected live run and the
// polled queue snapshot, so it is lifted into context. Mounted once in the [workspace] shell — the panel
// survives left-side navigation, which is what keeps a run's live stream uninterrupted.

export type WorkAuthor = { name: string; avatarUrl?: string }

export type InfraTab = 'schedules' | 'runtimes' | 'runs' | 'work'

// The panel navigates on its own — infra detail views (runtime / runner / schedule / live run) open INSIDE the
// panel, never via the left router. Per-tab drill-in state lives here (not in the tab components) so switching
// tabs or navigating the left half never loses a drill-in.
export type RuntimesDetail = { kind: 'runtime' | 'runner'; id: string } | null

type InfraPanelValue = {
  workspace: string
  open: boolean
  tab: InfraTab
  // Rail button semantics — same tab while open = collapse; otherwise open on that tab.
  toggleTab: (tab: InfraTab) => void
  // Non-toggling open (command palette, deep entries) — always ends open on the given tab.
  openTab: (tab: InfraTab) => void
  close: () => void
  // Live run selection (runs tab) — openRun() is the cross-page entry: any surface can push a run
  // into the right panel without navigating away.
  selectedRunId: string | null
  selectRun: (id: string | null) => void
  openRun: (id: string) => void
  // In-panel infra navigation — runtime/runner and schedule drill-ins (+ cross-tab entries used by the work tab).
  runtimesDetail: RuntimesDetail
  setRuntimesDetail: (d: RuntimesDetail) => void
  openRuntime: (kind: 'runtime' | 'runner', id: string) => void
  schedulesDetail: string | null
  setSchedulesDetail: (id: string | null) => void
  openSchedule: (id: string) => void
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
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [runtimesDetail, setRuntimesDetail] = useState<RuntimesDetail>(null)
  const [schedulesDetail, setSchedulesDetail] = useState<string | null>(null)
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

  const openRun = useCallback((id: string) => {
    setSelectedRunId(id)
    setTab('runs')
    setOpen(true)
  }, [])

  const openRuntime = useCallback((kind: 'runtime' | 'runner', id: string) => {
    setRuntimesDetail({ kind, id })
    setTab('runtimes')
    setOpen(true)
  }, [])

  const openSchedule = useCallback((id: string) => {
    setSchedulesDetail(id)
    setTab('schedules')
    setOpen(true)
  }, [])

  return (
    <InfraPanelContext.Provider
      value={{
        workspace,
        open,
        tab,
        toggleTab,
        openTab,
        close,
        selectedRunId,
        selectRun: setSelectedRunId,
        openRun,
        runtimesDetail,
        setRuntimesDetail,
        openRuntime,
        schedulesDetail,
        setSchedulesDetail,
        openSchedule,
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
