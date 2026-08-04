'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Activity,
  ArrowLeft,
  CalendarClock,
  ChevronsRight,
  FileText,
  FlaskConical,
  Network,
  Play,
  Server,
  Sparkles,
  type LucideIcon,
} from 'lucide-react'
import { useTranslations } from 'next-intl'

import { AgentChatPanel, type ChatUser } from '@/features/agent-chat'
import { HarnessPlaygroundPanel } from '@/features/harness-playground'
import { agentChatMissionSchema, agentReferenceSchema } from '@/entities/agent-session'
import { RELOAD_INFRA_FRAMES_EVENT } from '@/shared/lib/reload-infra-frames'
import { cn } from '@/shared/lib/utils'

import {
  MENTION_IN_CHAT_MESSAGE,
  OPEN_AGENT_SESSION_MESSAGE,
  OPEN_PLAYGROUND_MESSAGE,
  useInfraPanel,
  type InfraTab,
} from '../model/infra-panel-context'
import { FilesTab } from './files-tab'
import { KnowledgeTab } from './knowledge-tab'
import { WorkTab } from './work-tab'

// The floating infra panel — the right half of the split view. On md+ it takes real layout space as a flex-1
// sibling of main (so the eval side and the infra side each get half), but it *looks* detached: a floating
// card with a gap, rounded corners and a pop shadow. On mobile it is a floating right-hand sheet over a light
// scrim.
//
// The page tabs (schedules · runtimes · runs) host the REAL routed pages in same-origin iframes rendered
// chrome-less by the [workspace] layout (sec-fetch-dest=iframe → EmbedShell) — full existing screens, not
// re-implemented summaries. Each iframe owns its navigation (independent right side) and stays mounted across
// TAB SWITCHES while the panel is open, so flipping tabs or navigating the left half never interrupts a live
// view; CLOSING the panel discards the page iframes, so reopening renders each tab fresh. The header back
// button walks a parent-tracked per-tab stack (everdict:frame-nav reports). Eval-axis links inside an iframe
// post back here (everdict:left-nav) and navigate the LEFT router instead. The work tab stays purpose-built
// (the queue snapshot has no full page).

const TAB_META: Record<InfraTab, { icon: LucideIcon }> = {
  schedules: { icon: CalendarClock },
  runtimes: { icon: Server },
  runs: { icon: Play },
  work: { icon: Activity },
  agent: { icon: Sparkles },
  files: { icon: FileText },
  knowledge: { icon: Network },
  playground: { icon: FlaskConical },
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

export function InfraPanel({
  user,
  canFilesWrite = false,
  canFilesRun = false,
  canPlaygroundSubmit = false,
}: {
  user?: ChatUser
  canFilesWrite?: boolean
  canFilesRun?: boolean
  canPlaygroundSubmit?: boolean
} = {}) {
  const t = useTranslations('infraPanel')
  const router = useRouter()
  const {
    workspace,
    open,
    tab,
    close,
    frameRequest,
    mentionInChat,
    askAgent,
    pendingMention,
    consumePendingMention,
    openAgentSession,
    pendingSession,
    consumePendingSession,
    openPlayground,
    pendingPlaygroundTarget,
    consumePendingPlaygroundTarget,
  } = useInfraPanel()
  const frames = useRef<Partial<Record<PageTab, HTMLIFrameElement | null>>>({})
  // Tabs whose iframe is currently open — kept mounted (hidden) across TAB SWITCHES so a tab's in-iframe
  // navigation state and live streams survive while the panel stays open. The initial src is frozen per
  // tab at first mount (ref, not a prop off live state) — React must never rewrite src on re-render, or it
  // would undo the user's own in-iframe navigation.
  const [mountedTabs, setMountedTabs] = useState<PageTab[]>([])
  const initialSrc = useRef<Partial<Record<PageTab, string>>>({})
  // Per-tab navigation stacks (workspace-relative paths, current page last) — fed by everdict:frame-nav
  // reports from EmbedShell, consumed by the header back button.
  const [stacks, setStacks] = useState<Partial<Record<PageTab, string[]>>>({})
  // Deep-open requests already applied — a stale frameRequest must not resurrect an old deep target when a
  // tab remounts after the panel was closed (reopen = the tab's home, unless a NEW request arrived).
  const consumedFrameSeq = useRef(0)
  const everOpened = useRef(false)
  if (open) everOpened.current = true

  useEffect(() => {
    if (open && isPageTab(tab) && !mountedTabs.includes(tab)) {
      // A pending deep-open for this tab becomes its first document; otherwise the tab's home page.
      const pending =
        frameRequest && frameRequest.tab === tab && frameRequest.seq > consumedFrameSeq.current
          ? frameRequest
          : null
      if (pending) consumedFrameSeq.current = pending.seq
      initialSrc.current[tab] = pending ? pending.path : HOME_PATH[tab]
      setMountedTabs((prev) => [...prev, tab])
    }
  }, [open, tab, mountedTabs, frameRequest])

  // Closing the panel DISCARDS the page iframes (user decision: reopen = a fresh render per tab). Reopening
  // remounts the active tab's page from scratch — a clean, correctly-themed document — which also makes
  // close→reopen a reliable recovery gesture for any stuck frame. The work/agent tabs keep their state
  // (a conversation must survive a collapse).
  useEffect(() => {
    if (open || mountedTabs.length === 0) return
    setMountedTabs([])
    setStacks({})
    initialSrc.current = {}
    frames.current = {}
  }, [open, mountedTabs])

  // Deep-open requests (openRun/openRuntime/openSchedule) into an ALREADY-mounted iframe — applied
  // imperatively via contentWindow (first mounts consume the request through initialSrc instead).
  useEffect(() => {
    if (!frameRequest || !isPageTab(frameRequest.tab)) return
    const el = frames.current[frameRequest.tab]
    if (!el) return
    consumedFrameSeq.current = frameRequest.seq
    const target = withEmbed(`/${workspace}${frameRequest.path}`)
    try {
      el.contentWindow?.location.replace(target)
    } catch {
      el.src = target
    }
  }, [frameRequest, workspace])

  // '/{workspace}/runs/x?y' → '/runs/x?y' — the workspace-relative form HOME_PATH and the stacks use.
  const toRelative = useCallback(
    (href: string) => {
      const prefix = `/${workspace}`
      if (href === prefix) return '/'
      return href.startsWith(`${prefix}/`) ? href.slice(prefix.length) : href
    },
    [workspace]
  )

  // Header back button — navigate the ACTIVE tab's iframe to the previous entry in its own stack (or its
  // home page as the final fallback, so a deep-opened detail is never a dead end). Deliberately NOT
  // history.back(): an iframe shares the top-level joint session history, so going "back" there could undo
  // the user's LEFT-side navigation instead of this frame's. A hard replace also recovers foreign/stuck
  // documents that a soft in-frame navigation could never leave.
  const activeStack = isPageTab(tab) ? (stacks[tab] ?? []) : []
  const canGoBack =
    isPageTab(tab) &&
    (activeStack.length > 1 || (activeStack.length === 1 && activeStack[0] !== HOME_PATH[tab]))
  const goBack = useCallback(() => {
    if (!isPageTab(tab)) return
    const stack = stacks[tab] ?? []
    const target = (stack.length > 1 ? stack[stack.length - 2] : undefined) ?? HOME_PATH[tab]
    setStacks((prev) => ({ ...prev, [tab]: (prev[tab] ?? []).slice(0, -1) }))
    const el = frames.current[tab]
    if (!el) return
    const href = withEmbed(`/${workspace}${target}`)
    try {
      el.contentWindow?.location.replace(href)
    } catch {
      el.src = href
    }
  }, [tab, stacks, workspace])

  // Eval-axis links clicked inside an iframe (EmbedShell postMessage) → navigate the LEFT half.
  const onNavigate = useCallback(() => {
    if (typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches) {
      close()
    }
  }, [close])
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return
      const data = e.data as {
        type?: string
        href?: string
        bounce?: boolean
        reference?: unknown
        prompt?: unknown
        mission?: unknown
        fresh?: unknown
        sessionId?: unknown
        harnessId?: unknown
        version?: unknown
      } | null
      // A detail page inside an iframe (run / runtime) asked to mention its entity in the parent's agent chat
      // — optionally with a draft prompt pre-typed (the ask-agent variant) or a mission framing the chat for a
      // domain-specific task (the "edit in chat" variant).
      if (data?.type === MENTION_IN_CHAT_MESSAGE) {
        const parsed = agentReferenceSchema.safeParse(data.reference)
        const prompt =
          typeof data.prompt === 'string' && data.prompt.length > 0 ? data.prompt : undefined
        const mission = agentChatMissionSchema.safeParse(data.mission)
        if (prompt)
          askAgent(
            prompt,
            parsed.success ? parsed.data : undefined,
            mission.success ? mission.data : undefined,
            data.fresh === true
          )
        else if (parsed.success)
          mentionInChat(
            parsed.data,
            mission.success ? mission.data : undefined,
            data.fresh === true
          )
        return
      }
      // A comment thread's agent answer asked to open its backing discussion session (features/discuss posts
      // this — from an iframe detail page OR its own window, since a feature cannot import this widget).
      if (data?.type === OPEN_AGENT_SESSION_MESSAGE) {
        if (typeof data.sessionId === 'string' && data.sessionId.length > 0)
          openAgentSession(data.sessionId)
        return
      }
      // A harness detail page inside an iframe asked to open the playground on itself — a prefill, never a boot.
      if (data?.type === OPEN_PLAYGROUND_MESSAGE) {
        if (typeof data.harnessId === 'string' && data.harnessId.length > 0)
          openPlayground({
            harnessId: data.harnessId,
            ...(typeof data.version === 'string' && data.version.length > 0
              ? { version: data.version }
              : {}),
          })
        else openPlayground()
        return
      }
      // An iframe landed on an infra route (EmbedShell report) — record it on that tab's back stack.
      if (data?.type === 'everdict:frame-nav' && typeof data.href === 'string') {
        const href = data.href
        for (const pageTab of PAGE_TABS) {
          const frameWindow = frames.current[pageTab]?.contentWindow
          if (frameWindow && frameWindow === e.source) {
            const rel = toRelative(href)
            setStacks((prev) => {
              const stack = prev[pageTab] ?? []
              if (stack[stack.length - 1] === rel) return prev
              return { ...prev, [pageTab]: [...stack.slice(-49), rel] }
            })
            break
          }
        }
        return
      }
      if (data?.type === 'everdict:left-nav' && typeof data.href === 'string') {
        router.push(data.href)
        onNavigate()
        // A bounced document (a non-infra page that got INTO an iframe) — the panel is infra-only, so send
        // that iframe back to its tab's home page (and restart its back stack there).
        if (data.bounce) {
          for (const pageTab of PAGE_TABS) {
            const frameWindow = frames.current[pageTab]?.contentWindow
            if (frameWindow && frameWindow === e.source) {
              setStacks((prev) => ({ ...prev, [pageTab]: [] }))
              frameWindow.location.replace(withEmbed(`/${workspace}${HOME_PATH[pageTab]}`))
              break
            }
          }
        }
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [
    router,
    onNavigate,
    workspace,
    mentionInChat,
    askAgent,
    openAgentSession,
    openPlayground,
    toRelative,
  ])

  // A server-resolved per-device preference (locale / timezone) changed in the parent. The mounted iframes read
  // it server-side off the cookie and stay frozen, so router.refresh() in the switcher never reaches their
  // separate browsing context. Signal each frame to soft-refresh IN PLACE (everdict:refresh → EmbedShell calls
  // its own router.refresh()) — the server re-renders with the new cookie without a hard reload, so scroll,
  // in-iframe route and live streams survive and it feels like one app (not a flashing sub-frame). Theme is
  // client-only and syncs live via the storage event, so it is not signalled here.
  useEffect(() => {
    const onRefresh = () => {
      for (const el of Object.values(frames.current)) {
        el?.contentWindow?.postMessage({ type: 'everdict:refresh' }, window.location.origin)
      }
    }
    window.addEventListener(RELOAD_INFRA_FRAMES_EVENT, onRefresh)
    return () => window.removeEventListener(RELOAD_INFRA_FRAMES_EVENT, onRefresh)
  }, [])

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
              {isPageTab(tab) && (
                <button
                  type="button"
                  aria-label={t('back')}
                  onClick={goBack}
                  disabled={!canGoBack}
                  className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-35"
                >
                  <ArrowLeft className="size-4" />
                </button>
              )}
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
            {tab === 'files' && <FilesTab canWrite={canFilesWrite} canRun={canFilesRun} />}
            {tab === 'knowledge' && <KnowledgeTab />}
            {tab === 'playground' && (
              <div className="h-full">
                <HarnessPlaygroundPanel
                  pendingTarget={pendingPlaygroundTarget}
                  onConsumeTarget={consumePendingPlaygroundTarget}
                  canSubmit={canPlaygroundSubmit}
                  workspace={workspace}
                />
              </div>
            )}
            {tab === 'agent' && (
              <div className="h-full">
                <AgentChatPanel
                  pendingMention={pendingMention}
                  onConsumeMention={consumePendingMention}
                  pendingSession={pendingSession}
                  onConsumeSession={consumePendingSession}
                  user={user}
                />
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
