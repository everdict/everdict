'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Activity,
  CalendarClock,
  ChevronsRight,
  Play,
  Server,
  Sparkles,
  type LucideIcon,
} from 'lucide-react'
import { useTranslations } from 'next-intl'

import { AgentChatPanel } from '@/features/agent-chat'
import { cn } from '@/shared/lib/utils'

import { useInfraPanel, type InfraTab } from '../model/infra-panel-context'
import { WorkTab } from './work-tab'

// The floating infra panel — the right half of the split view. On md+ it takes real layout space as a flex-1
// sibling of main (so the eval side and the infra side each get half), but it *looks* detached: a floating
// card with a gap, rounded corners and a pop shadow. On mobile it is a floating right-hand sheet over a light
// scrim.
//
// The page tabs (schedules · runtimes · runs) host the REAL routed pages in same-origin iframes rendered
// chrome-less by the [workspace] layout (sec-fetch-dest=iframe → EmbedShell) — full existing screens, not
// re-implemented summaries. Each iframe owns its history (independent right-side navigation) and stays mounted
// once opened, so switching tabs or navigating the left half never interrupts a live view. Eval-axis links
// inside an iframe post back here (everdict:left-nav) and navigate the LEFT router instead. The work tab stays
// purpose-built (the queue snapshot has no full page).

const TAB_META: Record<InfraTab, { icon: LucideIcon }> = {
  schedules: { icon: CalendarClock },
  runtimes: { icon: Server },
  runs: { icon: Play },
  work: { icon: Activity },
  agent: { icon: Sparkles },
}

// The page tabs and their iframe home paths (workspace-relative).
const PAGE_TABS = ['schedules', 'runtimes', 'runs'] as const
type PageTab = (typeof PAGE_TABS)[number]
const HOME_PATH: Record<PageTab, string> = {
  schedules: '/schedules',
  runtimes: '/runtimes',
  runs: '/runs',
}

function isPageTab(tab: InfraTab): tab is PageTab {
  return (PAGE_TABS as readonly string[]).includes(tab)
}

// Full-document iframe loads carry ?embed=1 — the chrome-less marker for plain-HTTP origins where
// Sec-Fetch-Dest is not sent (see the [workspace] layout). Soft navigation inside the iframe keeps the bare
// layout without the param.
function withEmbed(path: string): string {
  return `${path}${path.includes('?') ? '&' : '?'}embed=1`
}

export function InfraPanel() {
  const t = useTranslations('infraPanel')
  const router = useRouter()
  const { workspace, open, tab, close, frameRequest } = useInfraPanel()
  const frames = useRef<Partial<Record<PageTab, HTMLIFrameElement | null>>>({})
  // Tabs whose iframe has been opened at least once — kept mounted (hidden) afterward so each tab's in-iframe
  // navigation state and live streams survive tab switches and panel collapse. The initial src is frozen per
  // tab at first mount (ref, not a prop off live state) — React must never rewrite src on re-render, or it
  // would undo the user's own in-iframe navigation.
  const [mountedTabs, setMountedTabs] = useState<PageTab[]>([])
  const initialSrc = useRef<Partial<Record<PageTab, string>>>({})
  const everOpened = useRef(false)
  if (open) everOpened.current = true

  useEffect(() => {
    if (open && isPageTab(tab) && !mountedTabs.includes(tab)) {
      // A pending deep-open for this tab becomes its first document; otherwise the tab's home page.
      initialSrc.current[tab] =
        frameRequest && frameRequest.tab === tab ? frameRequest.path : HOME_PATH[tab]
      setMountedTabs((prev) => [...prev, tab])
    }
  }, [open, tab, mountedTabs, frameRequest])

  // Deep-open requests (openRun/openRuntime/openSchedule) into an ALREADY-mounted iframe — applied
  // imperatively via contentWindow (first mounts consume the request through initialSrc instead).
  useEffect(() => {
    if (!frameRequest || !isPageTab(frameRequest.tab)) return
    const el = frames.current[frameRequest.tab]
    if (!el) return
    const target = withEmbed(`/${workspace}${frameRequest.path}`)
    try {
      el.contentWindow?.location.replace(target)
    } catch {
      el.src = target
    }
  }, [frameRequest, workspace])

  // Eval-axis links clicked inside an iframe (EmbedShell postMessage) → navigate the LEFT half.
  const onNavigate = useCallback(() => {
    if (typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches) {
      close()
    }
  }, [close])
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return
      const data = e.data as { type?: string; href?: string; bounce?: boolean } | null
      if (data?.type === 'everdict:left-nav' && typeof data.href === 'string') {
        router.push(data.href)
        onNavigate()
        // A bounced document (a non-infra page that got INTO an iframe) — the panel is infra-only, so send
        // that iframe back to its tab's home page.
        if (data.bounce) {
          for (const pageTab of PAGE_TABS) {
            const frameWindow = frames.current[pageTab]?.contentWindow
            if (frameWindow && frameWindow === e.source) {
              frameWindow.location.replace(withEmbed(`/${workspace}${HOME_PATH[pageTab]}`))
              break
            }
          }
        }
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [router, onNavigate, workspace])

  // Never opened → nothing to preserve. After the first open, collapse only HIDES the panel (iframes live on).
  if (!open && !everOpened.current) return null
  const { icon: Icon } = TAB_META[tab]

  return (
    <>
      {/* Mobile only — tap to close (a light scrim, not a dim). The md+ split has no backdrop. */}
      {open && (
        <button
          type="button"
          aria-label={t('collapse')}
          onClick={close}
          className="fixed inset-0 z-40 cursor-default bg-black/20 md:hidden"
        />
      )}
      <aside
        aria-label={t(`tab_${tab}`)}
        aria-hidden={!open}
        // Mobile: a floating fixed sheet. md+: an in-flow flex-1 column (half of the space next to the rail),
        // sticky full-height, with padding so the card inside floats clear of the viewport edges and the
        // top-right control cluster (the notification bell keeps its spot).
        style={{ top: 'var(--titlebar-h)', height: 'calc(100dvh - var(--titlebar-h))' }}
        className={cn(
          'fixed right-0 z-50 w-[min(420px,100vw)] p-2 pt-12',
          'md:sticky md:right-auto md:z-auto md:w-auto md:min-w-0 md:flex-1 md:basis-0 md:self-start md:pl-0',
          !open && 'hidden'
        )}
      >
        <div className="flex h-full flex-col overflow-hidden rounded-xl border border-border bg-background shadow-pop">
          <div className="flex items-center justify-between gap-2 border-b border-border px-3.5 py-2.5">
            <div className="flex min-w-0 items-center gap-2">
              <Icon className="size-4 shrink-0 text-primary" strokeWidth={1.75} />
              <h2 className="truncate text-[14px] font-[560] tracking-[-0.01em]">
                {t(`tab_${tab}`)}
              </h2>
            </div>
            <button
              type="button"
              aria-label={t('collapse')}
              onClick={close}
              className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <ChevronsRight className="size-4" />
            </button>
          </div>

          <div className="relative min-h-0 flex-1 overflow-hidden">
            {tab === 'work' && (
              <div className="h-full overflow-y-auto">
                <WorkTab onNavigate={onNavigate} />
              </div>
            )}
            {tab === 'agent' && (
              <div className="h-full">
                <AgentChatPanel />
              </div>
            )}
            {mountedTabs.map((pageTab) => (
              <iframe
                key={pageTab}
                ref={(el) => {
                  frames.current[pageTab] = el
                }}
                title={t(`tab_${pageTab}`)}
                // Frozen at first mount (see initialSrc) — afterwards the iframe owns its location.
                src={withEmbed(`/${workspace}${initialSrc.current[pageTab] ?? HOME_PATH[pageTab]}`)}
                className={cn('h-full w-full border-0', tab !== pageTab && 'hidden')}
              />
            ))}
          </div>
        </div>
      </aside>
    </>
  )
}
