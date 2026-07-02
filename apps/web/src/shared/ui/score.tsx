import { fmtScore, HEALTH_TEXT, rateHealth } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'

// 점수 원자 — passRate 는 건강도 색(green/amber/red), 수치 메트릭(mean-only)은 중립. 항상 모노 tabular-nums.
// 대시보드 전역에서 점수를 이 컴포넌트로 통일(색·서식 일관성).
export function Score({
  passRate,
  mean,
  className,
}: {
  passRate?: number | null
  mean?: number | null
  className?: string
}) {
  return (
    <span
      className={cn(
        'font-mono text-[12px] font-[510] tabular-nums',
        HEALTH_TEXT[rateHealth(passRate)],
        className
      )}
    >
      {fmtScore(passRate, mean)}
    </span>
  )
}
