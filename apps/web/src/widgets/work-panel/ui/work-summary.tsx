'use client'

import type { ReactNode } from 'react'
import { Activity, CalendarClock, CircleDashed, Loader2 } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { cn } from '@/shared/lib/utils'

import { useWorkPanel } from '../model/work-panel-context'

// Collapsed work-summary widget — lives in the floating top-right cluster. Always shows the running/queued/scheduled
// counts (never hidden). Clicking it opens the docking rail on the right (WorkRail — which actually takes layout
// space); while open it is highlighted = the close handle.
export function WorkSummary() {
  const t = useTranslations('workPanel')
  const { open, toggle, snapshot } = useWorkPanel()
  const totals = snapshot?.totals
  const running = totals?.running ?? 0
  const queued = totals?.queued ?? 0
  const upcoming = totals?.upcoming ?? 0

  return (
    <button
      type="button"
      onClick={toggle}
      aria-expanded={open}
      aria-label={t('summaryAria', { running, queued, upcoming })}
      className={cn(
        'flex h-8 items-center gap-2 rounded-md pl-1.5 pr-2 transition-colors',
        open
          ? 'bg-accent text-foreground'
          : 'text-muted-foreground hover:bg-accent hover:text-foreground'
      )}
    >
      <Activity
        className={cn('size-[18px] shrink-0', running > 0 && 'text-primary')}
        strokeWidth={1.75}
      />
      <span className="flex items-center gap-1 font-mono text-[11.5px] leading-none tabular-nums">
        <Stat
          title={t('running')}
          value={running}
          icon={<Loader2 className={cn('size-3', running > 0 && 'animate-spin')} />}
          tone={running > 0 ? 'primary' : 'muted'}
        />
        <span className="text-border-strong">·</span>
        <Stat
          title={t('queued')}
          value={queued}
          icon={<CircleDashed className="size-3" />}
          tone={queued > 0 ? 'default' : 'muted'}
        />
        <span className="text-border-strong">·</span>
        <Stat
          title={t('upcoming')}
          value={upcoming}
          icon={<CalendarClock className="size-3" />}
          tone={upcoming > 0 ? 'default' : 'muted'}
        />
      </span>
    </button>
  )
}

// A single count cell — icon + number. Dimmed when 0, primary when running. title = the accessibility/tooltip label.
function Stat({
  title,
  value,
  icon,
  tone,
}: {
  title: string
  value: number
  icon: ReactNode
  tone: 'primary' | 'default' | 'muted'
}) {
  return (
    <span
      title={title}
      className={cn(
        'flex items-center gap-0.5',
        tone === 'primary' && 'text-primary',
        tone === 'muted' && 'text-faint'
      )}
    >
      {icon}
      {value}
    </span>
  )
}
