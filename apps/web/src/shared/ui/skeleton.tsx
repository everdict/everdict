import { cn } from '@/shared/lib/utils'

// 로딩 자리표시자 — 화면이 도착하기 전에 "무엇이 올 자리인지"만 그린다. 색은 표면 토큰(`muted`)에서 오고,
// 크기는 항상 호출부가 정한다: 스켈레톤이 자기 크기를 들고 있으면 진짜 내용과 어긋나 도착 순간에 화면이 튄다.
//
// 스크린 리더에는 존재하지 않는다(`aria-hidden`) — 읽어 줄 내용이 없는 장식이고, 로딩 사실은 라우트 경계가
// 알린다. 문자열이 없으므로 메시지 카탈로그에 들어갈 것도 없다.
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('animate-pulse rounded-md bg-muted', className)} />
}

// 텍스트 한 줄 자리. 마지막 줄만 짧게 끝나는 건 실제 문단이 그렇기 때문이다 — 모든 줄이 같은 길이면
// 자리표시자로 읽히지 않고 표처럼 보인다.
export function SkeletonLines({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn('space-y-2', className)}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={cn('h-3.5', i === lines - 1 ? 'w-2/5' : 'w-full')} />
      ))}
    </div>
  )
}

// 목록 화면의 기본 로딩 경계 — 제목 + 설명 + 행. 이 앱의 화면 대부분이 이 모양이라, 자기 세그먼트에
// `loading.tsx` 를 두지 않은 라우트는 전부 이것을 물려받는다(더 특징적인 화면은 자기 것으로 덮는다).
//
// `scoped` 는 팀 아래 화면의 스코프 바 자리다. 미리 잡아 두지 않으면 그 줄이 도착하는 순간 아래의 모든
// 것이 한 번 밀려 내려간다 — 자리표시자가 만들면 안 되는 유일한 것이 그 점프다.
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
