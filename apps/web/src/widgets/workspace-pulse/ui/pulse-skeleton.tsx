import { Skeleton } from '@/shared/ui/skeleton'

// 펄스가 도착하기 전의 자리 — 타일 여덟 개와 차트 세 개. 진짜 화면과 같은 격자·같은 높이로 잡는 이유는
// 하나다: 숫자가 도착하는 순간 아래의 활동 피드가 밀려 내려가면 안 된다.
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

// 활동 피드의 자리 — 얼굴 + 한 줄이 열네 번.
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
