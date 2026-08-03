import { Skeleton } from '@/shared/ui/skeleton'

// 이슈 목록이 도착하기 전의 화면. 라우트 경계(`loading.tsx`)가 그리는 것이라 서버 렌더를 기다리지 않는다 —
// 필터 칩을 누른 순간 화면이 바뀌고, 행은 그 자리에 채워진다.
//
// 행 수를 실제 페이지 크기(50)로 맞추지 않는 이유는 하나다: 스켈레톤은 "곧 온다"는 신호이지 목록의 예고편이
// 아니고, 화면 하나를 채우고 나면 그 아래는 아무도 보지 않는다.
const SKELETON_ROWS = 8

export function IssueListSkeleton({ scoped = false }: { scoped?: boolean }) {
  return (
    <div className="@container space-y-6">
      {/* 팀 스코프 바 — 팀 아래 화면에서만 존재하므로 그 화면에서만 자리를 잡는다. */}
      {scoped && <Skeleton className="h-8 w-64" />}
      <div className="space-y-1">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-3.5 w-72" />
      </div>
      {/* 툴바 — 왼쪽에 「필터」, 오른쪽에 건수와 「표시」. 자리를 미리 잡아 두지 않으면 도착하는 순간
          아래의 모든 행이 한 줄 밀려 내려간다. */}
      <div className="flex flex-wrap items-center gap-2">
        <Skeleton className="h-7 w-16" />
        <div className="ml-auto flex items-center gap-2">
          <Skeleton className="h-4 w-12" />
          <Skeleton className="h-7 w-16" />
        </div>
      </div>
      {/* 그룹 머리글 — 목록은 기본으로 상태별로 묶여 온다. */}
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
