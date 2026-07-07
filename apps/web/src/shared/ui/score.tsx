import { fmtScore, HEALTH_TEXT, rateHealth } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'

// Score atom — passRate uses health colors (green/amber/red), numeric metrics (mean-only) are neutral. Always mono tabular-nums.
// Standardize scores across the dashboard through this component (color·format consistency).
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
