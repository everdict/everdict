import { Skeleton } from '@/shared/ui/skeleton'

// The screen before the issue list arrives. It is drawn by the route boundary (`loading.tsx`), so it does not wait for the server render —
// the screen changes the moment a filter chip is pressed, and the rows fill in where they are.
//
// The row count is deliberately not the real page size (50) for one reason: a skeleton is a signal that something is COMING rather than a
// trailer for the list, and once one screenful is filled nobody looks below it.
const SKELETON_ROWS = 8

export function IssueListSkeleton({ scoped = false }: { scoped?: boolean }) {
  return (
    <div className="@container space-y-6">
      {/* The team scope bar — it exists only on screens under a team, so it reserves space only there. */}
      {scoped && <Skeleton className="h-8 w-64" />}
      <div className="space-y-1">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-3.5 w-72" />
      </div>
      {/* The toolbar — "filter" on the left, the count and "display" on the right. Without reserving its space, every row below shifts down a
          line the moment it arrives. */}
      <div className="flex flex-wrap items-center gap-2">
        <Skeleton className="h-7 w-16" />
        <div className="ml-auto flex items-center gap-2">
          <Skeleton className="h-4 w-12" />
          <Skeleton className="h-7 w-16" />
        </div>
      </div>
      {/* The group header — the list arrives grouped by status by default. */}
      <div className="flex items-center gap-1.5">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-4 w-6 rounded-full" />
      </div>
      <div className="space-y-2">
        {Array.from({ length: SKELETON_ROWS }, (_, i) => (
          <div
            key={i}
            className="flex items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-2"
          >
            <Skeleton className="size-3.5 shrink-0 rounded-full" />
            <Skeleton className="size-3.5 shrink-0 rounded-full" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <Skeleton className="h-3.5 w-1/2" />
              <Skeleton className="h-3 w-1/4" />
            </div>
            <Skeleton className="hidden h-3 w-16 shrink-0 @lg:block" />
            <Skeleton className="size-5 shrink-0 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  )
}
