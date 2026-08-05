import { Skeleton } from '@/shared/ui/skeleton'

// 탭 사이를 옮길 때의 경계 — 레이아웃(팀 이름·탭)은 그대로 두고 몸통만 자리표시자로 바꾼다. 기본 경계는
// `[workspace]/loading.tsx` 라 설정 화면 전체가 한 번 사라졌다가 돌아오는데, 탭 라우트에서는 그 점멸이
// "다른 화면으로 갔다"고 읽힌다.
export default function TeamSettingsLoading() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-[220px] rounded-lg" />
      <Skeleton className="h-7 w-24 rounded-md" />
    </div>
  )
}
