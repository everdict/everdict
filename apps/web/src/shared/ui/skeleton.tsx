import { cn } from '@/shared/lib/utils'

// The loading placeholder — before a screen arrives it draws only "what is going to be here". The colour comes from the surface token (`muted`)
// and the SIZE is always the caller's: a skeleton carrying its own size disagrees with the real content and the screen jumps on arrival.
//
// It does not exist for a screen reader (`aria-hidden`) — it is decoration with nothing to read out, and the loading fact is announced by the
// route boundary. Having no strings, it has nothing to put in a message catalog.
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('animate-pulse rounded-md bg-muted', className)} />
}

// The slot for one line of text. Only the LAST line ends short because that is what a real paragraph does — with every line the same length it
// does not read as a placeholder and looks like a table.
export function SkeletonLines({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn('space-y-2', className)}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={cn('h-3.5', i === lines - 1 ? 'w-2/5' : 'w-full')} />
      ))}
    </div>
  )
}

// The default loading boundary for a list screen — a title, a description and rows. Most of this app's screens are this shape, so every route
// that does not put a `loading.tsx` in its own segment inherits this one (a more distinctive screen overrides it with its own).
//
// `scoped` is the slot for the scope bar on screens under a team. Not reserved, everything below shifts down once that line arrives —
// and that jump is the one thing a placeholder must never cause.
export function ListPageSkeleton({
  scoped = false,
  rows = 6,
}: {
  scoped?: boolean
  rows?: number
}) {
  return (
    <div className="space-y-6">
      {scoped && <Skeleton className="h-8 w-64" />}
      <div className="space-y-1">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-3.5 w-72" />
      </div>
      <div className="space-y-2">
        {Array.from({ length: rows }, (_, i) => (
          <Skeleton key={i} className="h-14 rounded-lg" />
        ))}
      </div>
    </div>
  )
}
