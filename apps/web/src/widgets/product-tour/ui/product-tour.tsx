'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'

import { START_TOUR_EVENT } from '@/shared/lib/tour'
import { cn } from '@/shared/lib/utils'
import { buttonVariants } from '@/shared/ui/button'

// The interactive onboarding tour (coach marks) for a new user — implemented directly, with no dependency.
// A welcome card → a spotlight over the sidebar's key elements (data-tour anchors), with each step moving the MAIN screen to that section
// so it reads as "the screen moves and points". The anchors are the sidebar, which exists on every route, so they survive soft navigation
// (ProductTour mounts on AppShell and keeps its state across route changes). It starts automatically on the first desktop visit
// (localStorage) and is re-run afterwards through the `everdict:start-tour` event (the guide page's "take the tour" button).
const TOUR_VERSION = 'v1'
const DONE_KEY = `everdict:tour:done:${TOUR_VERSION}`

type Placement = 'right' | 'left' | 'bottom' | 'top'

interface TourStep {
  anchor: string // the data-tour value of a screen element (sidebar nav · search · the infra rail · notifications · account)
  titleKey: string
  bodyKey: string
  placement: Placement
  href?: string // the workspace-relative path this step moves the main screen to ('' = the overview/workspace root, undefined = do not move)
}

// It sweeps every major screen in sidebar-nav order: workspace → search → overview → issues → projects → initiatives (the tracker,
// "why we evaluate") → harnesses → datasets → scorecards → judges → store → views → guide → notifications → infra → account.
// The evaluation-primitive steps have their anchors inside the collapsed "Evaluation" group, but each step navigates to that screen first
// through href, which expands the group automatically, so the spotlight works.
const STEPS: TourStep[] = [
  {
    anchor: 'workspace-switcher',
    titleKey: 'workspace.title',
    bodyKey: 'workspace.body',
    placement: 'bottom',
  },
  { anchor: 'search', titleKey: 'search.title', bodyKey: 'search.body', placement: 'bottom' },
  {
    anchor: 'nav-overview',
    titleKey: 'overview.title',
    bodyKey: 'overview.body',
    placement: 'right',
    href: '',
  },
  {
    anchor: 'nav-issues',
    titleKey: 'issues.title',
    bodyKey: 'issues.body',
    placement: 'right',
    href: '/issues',
  },
  {
    anchor: 'nav-projects',
    titleKey: 'projects.title',
    bodyKey: 'projects.body',
    placement: 'right',
    href: '/projects',
  },
  {
    anchor: 'nav-initiatives',
    titleKey: 'initiatives.title',
    bodyKey: 'initiatives.body',
    placement: 'right',
    href: '/initiatives',
  },
  {
    anchor: 'nav-harnesses',
    titleKey: 'harnesses.title',
    bodyKey: 'harnesses.body',
    placement: 'right',
    href: '/harnesses',
  },
  {
    anchor: 'nav-datasets',
    titleKey: 'datasets.title',
    bodyKey: 'datasets.body',
    placement: 'right',
    href: '/datasets',
  },
  {
    anchor: 'nav-scorecards',
    titleKey: 'scorecards.title',
    bodyKey: 'scorecards.body',
    placement: 'right',
    href: '/scorecards',
  },
  {
    anchor: 'nav-judges',
    titleKey: 'judges.title',
    bodyKey: 'judges.body',
    placement: 'right',
    href: '/judges',
  },
  {
    anchor: 'nav-store',
    titleKey: 'store.title',
    bodyKey: 'store.body',
    placement: 'right',
    href: '/store',
  },
  {
    anchor: 'nav-views',
    titleKey: 'views.title',
    bodyKey: 'views.body',
    placement: 'right',
    href: '/views',
  },
  {
    anchor: 'nav-guide',
    titleKey: 'guide.title',
    bodyKey: 'guide.body',
    placement: 'right',
    href: '/guide',
  },
  {
    anchor: 'notifications',
    titleKey: 'notifications.title',
    bodyKey: 'notifications.body',
    placement: 'bottom',
  },
  { anchor: 'infra-rail', titleKey: 'infra.title', bodyKey: 'infra.body', placement: 'left' },
  { anchor: 'user-menu', titleKey: 'account.title', bodyKey: 'account.body', placement: 'top' },
]

function isDesktop(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches
}

// The spotlight — four dark panels around the highlighted region (the hole) leave only the target crisp (clicks pass through the hole).
function Spotlight({ rect }: { rect: DOMRect }) {
  const pad = 4
  const x = rect.left - pad
  const y = rect.top - pad
  const w = rect.width + pad * 2
  const h = rect.height + pad * 2
  const panel = 'absolute bg-black/55 backdrop-blur-[1px]'
  return (
    <>
      <div className={panel} style={{ top: 0, left: 0, right: 0, height: Math.max(0, y) }} />
      <div className={panel} style={{ top: y + h, left: 0, right: 0, bottom: 0 }} />
      <div className={panel} style={{ top: y, left: 0, width: Math.max(0, x), height: h }} />
      <div className={panel} style={{ top: y, left: x + w, right: 0, height: h }} />
    </>
  )
}

export function ProductTour({ workspace }: { workspace: string }) {
  const t = useTranslations('tour')
  const router = useRouter()
  const pathname = usePathname()
  const [running, setRunning] = useState(false)
  const [welcome, setWelcome] = useState(true)
  const [index, setIndex] = useState(0)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)

  const step = running && !welcome ? STEPS[index] : null

  // Automatic start on a first visit (desktop only — on mobile the sidebar is a drawer, so the anchors are hidden).
  useEffect(() => {
    if (!isDesktop()) return
    let done = false
    try {
      done = localStorage.getItem(DONE_KEY) !== null
    } catch {
      done = true // with storage unreachable (private mode, etc.) it does not auto-start.
    }
    if (done) return
    const id = window.setTimeout(() => {
      setWelcome(true)
      setIndex(0)
      setRunning(true)
    }, 700)
    return () => window.clearTimeout(id)
  }, [])

  // The re-run event (the guide page button, etc.). The tour anchors are the desktop sidebar, so it is silently ignored on mobile.
  useEffect(() => {
    const start = () => {
      if (!isDesktop()) return
      setWelcome(true)
      setIndex(0)
      setRunning(true)
    }
    window.addEventListener(START_TOUR_EVENT, start)
    return () => window.removeEventListener(START_TOUR_EVENT, start)
  }, [])

  const finish = useCallback(() => {
    setRunning(false)
    setRect(null)
    setPos(null)
    try {
      localStorage.setItem(DONE_KEY, '1')
    } catch {
      // A storage failure is ignored — all that matters is that it closes for this session.
    }
  }, [])

  // A step with an href moves the main screen (the sidebar anchor stays put, so the spotlight remains stable).
  // href === '' means "go to the overview (the workspace root)", so only `undefined` counts as "do not move".
  useEffect(() => {
    if (step?.href === undefined) return
    const target = `/${workspace}${step.href}`
    if (pathname !== target) router.push(target)
  }, [step, workspace, pathname, router])

  // Measure the target anchor's position (on a step change and on scroll/resize). Slightly delayed right after a route change so the layout can settle.
  useEffect(() => {
    if (!step) return
    let raf = 0
    const measure = () => {
      const el = document.querySelector<HTMLElement>(`[data-tour="${step.anchor}"]`)
      if (!el) {
        setRect(null) // with no anchor found, only the card is shown centred (so the step does not disappear).
        return
      }
      el.scrollIntoView({ block: 'nearest' })
      setRect(el.getBoundingClientRect())
    }
    const delay = step.href ? 240 : 60
    const timer = window.setTimeout(() => {
      raf = requestAnimationFrame(measure)
    }, delay)
    const onMove = () => {
      raf = requestAnimationFrame(measure)
    }
    window.addEventListener('resize', onMove)
    window.addEventListener('scroll', onMove, true)
    return () => {
      window.clearTimeout(timer)
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onMove)
      window.removeEventListener('scroll', onMove, true)
    }
  }, [step])

  // The card's position — the placement is computed from the target rect plus the card's real size, then clamped inside the viewport.
  useLayoutEffect(() => {
    if (!rect || !cardRef.current || !step) return
    const card = cardRef.current.getBoundingClientRect()
    const gap = 12
    const vw = window.innerWidth
    const vh = window.innerHeight
    let top = rect.top
    let left = rect.left
    const midY = rect.top + rect.height / 2 - card.height / 2 // left/right placement aligns to the target's vertical centre (natural even against a thin vertical rail)
    if (step.placement === 'right') {
      left = rect.right + gap
      top = midY
    } else if (step.placement === 'left') {
      left = rect.left - card.width - gap
      top = midY
    } else if (step.placement === 'bottom') {
      top = rect.bottom + gap
      left = rect.left
    } else {
      top = rect.top - card.height - gap
      left = rect.left
    }
    left = Math.min(Math.max(8, left), vw - card.width - 8)
    top = Math.min(Math.max(8, top), vh - card.height - 8)
    setPos({ top, left })
  }, [rect, step])

  if (!running) return null

  // The welcome card — a centred modal. Start or skip.
  if (welcome) {
    return (
      <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/55 backdrop-blur-[1px] p-4">
        <div
          role="dialog"
          aria-modal="true"
          className="w-full max-w-sm rounded-xl border border-border bg-popover p-6 text-popover-foreground shadow-pop"
        >
          <div className="text-2xl">👋</div>
          <h2 className="mt-2 text-[16px] font-[600] tracking-tight text-foreground">
            {t('welcome.title')}
          </h2>
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
            {t('welcome.body')}
          </p>
          <div className="mt-5 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={finish}
              className={buttonVariants({ size: 'sm', variant: 'ghost' })}
            >
              {t('skip')}
            </button>
            <button
              type="button"
              onClick={() => {
                setWelcome(false)
                setIndex(0)
              }}
              className={buttonVariants({ size: 'sm' })}
            >
              {t('start')}
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (!step) return null
  const total = STEPS.length
  const last = index === total - 1
  const cardStyle = pos
    ? { top: pos.top, left: pos.left }
    : rect
      ? { visibility: 'hidden' as const }
      : { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }

  return (
    <div className="fixed inset-0 z-[80]">
      {rect ? (
        <Spotlight rect={rect} />
      ) : (
        <div className="absolute inset-0 bg-black/55 backdrop-blur-[1px]" />
      )}
      {rect ? (
        <div
          className="pointer-events-none absolute rounded-md ring-2 ring-primary transition-all duration-200"
          style={{
            top: rect.top - 4,
            left: rect.left - 4,
            width: rect.width + 8,
            height: rect.height + 8,
          }}
        />
      ) : null}
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        className="absolute w-[300px] rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-pop"
        style={cardStyle}
      >
        <div className="mb-1 text-[11px] font-[510] text-faint">
          {index + 1} / {total}
        </div>
        <h3 className="text-[13px] font-[560] text-foreground">{t(step.titleKey)}</h3>
        <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{t(step.bodyKey)}</p>
        <div className="mt-3.5 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={finish}
            className="text-[12px] text-muted-foreground transition-colors hover:text-foreground"
          >
            {t('skip')}
          </button>
          <div className="flex items-center gap-2">
            {index > 0 ? (
              <button
                type="button"
                onClick={() => setIndex((i) => i - 1)}
                className={buttonVariants({ size: 'xs', variant: 'secondary' })}
              >
                {t('back')}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => (last ? finish() : setIndex((i) => i + 1))}
              className={cn(buttonVariants({ size: 'xs' }))}
            >
              {last ? t('done') : t('next')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
