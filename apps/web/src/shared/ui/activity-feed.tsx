import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

import { fmtDateTimeFull, fmtTimeAgo } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { Avatar } from '@/shared/ui/avatar'

// A Linear-style activity feed — the shared skeleton that makes "who · did what · when" read as one line.
// Every screen that shows history (the History of an issue, project or initiative; a dataset's Activity) uses this one set:
// re-assembling `event · name · date` per screen makes the same event read differently on each of them.
// This atom uses no hooks (it renders identically on the server and the client) — the locale and timezone are passed in by the caller.
export type ActivityTone = 'neutral' | 'success' | 'danger' | 'warning' | 'info'

// The node badge's icon colour — the only colour signal, distinguishing an event's nature at a glance (success, alert, in progress).
const TONE_TEXT: Record<ActivityTone, string> = {
  neutral: 'text-muted-foreground',
  success: 'text-[var(--color-success)]',
  danger: 'text-destructive',
  warning: 'text-[var(--color-warning)]',
  info: 'text-[var(--color-link)]',
}

export interface ActivityActor {
  name: string
  avatarUrl?: string
}

export function ActivityFeed({ children, className }: { children: ReactNode; className?: string }) {
  return <ol className={cn('space-y-0', className)}>{children}</ol>
}

// One line = the node (the actor's face plus an event icon badge) · the sentence · value chips · a relative time.
// When the actor is known the FACE is the node and the event icon attaches as a badge at its lower right (a person's action).
// For an unknown subject (a system such as GitHub sync or regression watching) the event icon itself is the node instead of a face.
// There is no vertical line connecting the nodes — with a face on every row, drawing the line too lets decoration beat content.
export function ActivityRow({
  actor,
  icon: Icon,
  tone = 'neutral',
  at,
  locale,
  timeZone,
  children,
}: {
  actor?: ActivityActor
  icon: LucideIcon
  tone?: ActivityTone
  at: string
  locale: string
  timeZone?: string
  children: ReactNode
}) {
  return (
    <li className="flex gap-2.5 pb-3.5 last:pb-0">
      <span className="relative shrink-0">
        {actor ? (
          <>
            <Avatar
              name={actor.name}
              {...(actor.avatarUrl !== undefined ? { url: actor.avatarUrl } : {})}
              size="md"
              className="rounded-full"
            />
            <span
              className={cn(
                'absolute -bottom-1 -right-1 grid size-3.5 place-items-center rounded-full bg-background ring-2 ring-background',
                TONE_TEXT[tone]
              )}
            >
              <Icon className="size-3" strokeWidth={2.25} />
            </span>
          </>
        ) : (
          <span
            className={cn(
              'grid size-6 place-items-center rounded-full bg-secondary ring-1 ring-inset ring-border',
              TONE_TEXT[tone]
            )}
          >
            <Icon className="size-3.5" strokeWidth={1.75} />
          </span>
        )}
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-1 pt-0.5 text-[12.5px] leading-tight text-muted-foreground">
        {children}
        <ActivityTime at={at} locale={locale} timeZone={timeZone} />
      </div>
    </li>
  )
}

// The actor's name — the sentence's subject. Only the name is bold and the predicate stays muted, so the PERSON is seen first when sweeping.
export function ActivityActorName({ name }: { name: string }) {
  return <span className="font-[560] text-foreground">{name}</span>
}

// The relative time (absolute on hover). It attaches to the end of the sentence and wraps naturally with it.
export function ActivityTime({
  at,
  locale,
  timeZone,
}: {
  at: string
  locale: string
  timeZone?: string
}) {
  return (
    <time
      dateTime={at}
      className="shrink-0 text-[11px] text-faint"
      title={fmtDateTimeFull(at, { locale, ...(timeZone !== undefined ? { timeZone } : {}) })}
    >
      {fmtTimeAgo(at, locale, timeZone)}
    </time>
  )
}
