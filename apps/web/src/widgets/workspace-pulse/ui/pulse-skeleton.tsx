import { Skeleton } from '@/shared/ui/skeleton'

// The placeholder before the pulse arrives — eight tiles and three charts. It uses the real screen's grid and heights for one reason:
// the activity feed below must not be pushed down the moment the numbers arrive.
export function PulseSkeleton() {
  return (
    <div className="space-y-7">
      <div className="grid grid-cols-2 gap-3 @2xl:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-[102px] rounded-lg" />
        ))}
      </div>
      <div className="space-y-5">
        <Skeleton className="h-[248px] rounded-lg" />
        <div className="grid grid-cols-1 gap-5 @4xl:grid-cols-2">
          <Skeleton className="h-[248px] rounded-lg" />
          <Skeleton className="h-[248px] rounded-lg" />
        </div>
      </div>
    </div>
  )
}

// The activity feed's placeholder — a face plus one line, fourteen times.
export function ActivitySkeleton() {
  return (
    <div className="space-y-2.5">
      <Skeleton className="h-4 w-24" />
      <div className="space-y-3.5 rounded-lg border bg-card p-3.5">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="flex items-center gap-2.5">
            <Skeleton className="size-6 shrink-0 rounded-full" />
            <Skeleton className="h-3.5 w-full max-w-[420px]" />
          </div>
        ))}
      </div>
    </div>
  )
}
