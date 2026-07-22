'use client'

import { useCallback } from 'react'
import { Activity, CalendarClock, ChevronsRight, Play, Server, type LucideIcon } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { cn } from '@/shared/lib/utils'

import { useInfraPanel, type InfraTab } from '../model/infra-panel-context'
import { RunsTab } from './runs-tab'
import { RuntimesTab } from './runtimes-tab'
import { SchedulesTab } from './schedules-tab'
import { WorkTab } from './work-tab'

// The floating infra panel — the right half of the split view. On md+ it takes real layout space as a flex-1
// sibling of main (so the eval side and the infra side each get half), but it *looks* detached: a floating
// card with a gap, rounded corners and a pop shadow instead of a flush docked column. On mobile it is a
// floating right-hand sheet over a light scrim. Mounted in the shell (not the route), so left-side navigation
// never unmounts it — a selected run's live stream keeps playing.
// The panel is SELF-SUFFICIENT: infra content shows its full content here (no "full page" escape hatch — the
// user runs the two halves independently; routed infra pages remain URL-reachable only).

const TAB_META: Record<InfraTab, { icon: LucideIcon }> = {
  schedules: { icon: CalendarClock },
  runtimes: { icon: Server },
  runs: { icon: Play },
  work: { icon: Activity },
}

export function InfraPanel() {
  const t = useTranslations('infraPanel')
  const { open, tab, close, selectedRunId } = useInfraPanel()

  // Close on navigation only when a mobile overlay (the md+ split keeps the detail beside it = a persistent panel).
  const onNavigate = useCallback(() => {
    if (typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches) {
      close()
    }
  }, [close])

  if (!open) return null
  const { icon: Icon } = TAB_META[tab]
  // The runs tab stays mounted across tab switches while a run is selected — its live log/screen polling
  // must not restart just because the user peeked at another tab.
  const keepRunsMounted = selectedRunId !== null

  return (
    <>
      {/* Mobile only — tap to close (a light scrim, not a dim). The md+ split has no backdrop. */}
      <button
        type="button"
        aria-label={t('collapse')}
        onClick={close}
        className="fixed inset-0 z-40 cursor-default bg-black/20 md:hidden"
      />
      <aside
        aria-label={t(`tab_${tab}`)}
        // Mobile: a floating fixed sheet. md+: an in-flow flex-1 column (half of the space next to the rail),
        // sticky full-height, with padding so the card inside floats clear of the viewport edges and the
        // top-right control cluster (the notification bell keeps its spot).
        style={{ top: 'var(--titlebar-h)', height: 'calc(100dvh - var(--titlebar-h))' }}
        className={cn(
          'fixed right-0 z-50 w-[min(420px,100vw)] p-2 pt-12',
          'md:sticky md:right-auto md:z-auto md:w-auto md:min-w-0 md:flex-1 md:basis-0 md:self-start md:pl-0'
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

          <div className="min-h-0 flex-1 overflow-y-auto">
            {tab === 'work' && <WorkTab onNavigate={onNavigate} />}
            {tab === 'schedules' && <SchedulesTab onNavigate={onNavigate} />}
            {tab === 'runtimes' && <RuntimesTab />}
            {(tab === 'runs' || keepRunsMounted) && (
              <div className={tab === 'runs' ? undefined : 'hidden'}>
                <RunsTab />
              </div>
            )}
          </div>
        </div>
      </aside>
    </>
  )
}
