'use client'

import { Activity, Bot, CalendarClock, Play, Server, type LucideIcon } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { cn } from '@/shared/lib/utils'
import { Tooltip } from '@/shared/ui/tooltip'

import { useInfraPanel, type InfraTab } from '../model/infra-panel-context'

// The vertical rail — the device that separates the eval side (left) from the infra side (right). A vertically
// centered linear stack of toggle buttons (schedules · runtimes · runs · work): clicking one opens the floating
// infra panel on that tab, clicking the active one collapses the panel again. On md+ it is a slim in-flow column
// (real layout space = a visible boundary between the two halves); on mobile it floats over the right edge.

const TABS: { tab: InfraTab; icon: LucideIcon }[] = [
  { tab: 'schedules', icon: CalendarClock },
  { tab: 'runtimes', icon: Server },
  { tab: 'runs', icon: Play },
  { tab: 'work', icon: Activity },
  { tab: 'agent', icon: Bot },
]

function RailButtons() {
  const t = useTranslations('infraPanel')
  const { open, tab, toggleTab, snapshot } = useInfraPanel()
  const running = snapshot?.totals.running ?? 0
  const queued = snapshot?.totals.queued ?? 0
  const workBadge = running + queued

  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-border bg-card p-0.5 shadow-raise">
      {TABS.map(({ tab: id, icon: Icon }) => {
        const active = open && tab === id
        const badge = id === 'work' ? workBadge : 0
        return (
          <Tooltip key={id} content={t(`tab_${id}`)} side="top" align="end">
            <button
              type="button"
              onClick={() => toggleTab(id)}
              aria-pressed={active}
              aria-label={t(`tab_${id}`)}
              className={cn(
                'relative grid size-8 place-items-center rounded-md transition-colors',
                active
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              )}
            >
              <Icon
                className={cn('size-[17px]', id === 'work' && running > 0 && 'text-primary')}
                strokeWidth={1.75}
              />
              {badge > 0 && (
                <span
                  className={cn(
                    'absolute -right-0.5 -top-0.5 grid min-w-[15px] place-items-center rounded-full px-0.5 font-mono text-[9px] leading-[15px] tabular-nums',
                    running > 0
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-muted-foreground'
                  )}
                >
                  {badge}
                </span>
              )}
            </button>
          </Tooltip>
        )
      })}
    </div>
  )
}

export function InfraRail() {
  return (
    <>
      {/* Mobile — no room for an in-flow column, so the rail floats over the right edge (still vertically centered). */}
      <div className="fixed right-1.5 top-1/2 z-40 -translate-y-1/2 md:hidden">
        <RailButtons />
      </div>
      {/* md+ — a slim in-flow column between main and the panel; the vertically centered button stack is the divider. */}
      <div
        style={{ top: 'var(--titlebar-h)', height: 'calc(100dvh - var(--titlebar-h))' }}
        className="sticky hidden w-11 shrink-0 flex-col items-center justify-center self-start md:flex"
      >
        <RailButtons />
      </div>
    </>
  )
}
