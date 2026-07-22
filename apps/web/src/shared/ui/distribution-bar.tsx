import { cn } from '@/shared/lib/utils'

// 범주형(tier/string) 메트릭의 라벨 분포를 한 줄 세그먼트 바 + 범례로 보여주는 원자. 각 세그먼트 폭은 빈도에 비례하고,
// 최빈값(mode)은 진하게 강조한다. 순수 표현 컴포넌트 — 엔티티에 의존하지 않도록 원시 세그먼트만 받는다(FSD shared 계층).
// 색은 고정 팔레트를 라벨 순서대로 순환 배정(라벨→색 안정적, 스코어카드 간 동일 라벨은 위치가 같아 대체로 일관).
const PALETTE = [
  'var(--color-success)',
  'var(--color-primary)',
  'var(--color-warning)',
  'var(--color-destructive)',
  'var(--color-link)',
  'var(--color-muted-foreground)',
]

export function DistributionBar({
  segments,
  mode,
  className,
}: {
  segments: readonly { label: string; count: number }[]
  mode?: string
  className?: string
}) {
  const total = segments.reduce((a, s) => a + s.count, 0) || 1
  return (
    <div className={cn('min-w-0 space-y-1', className)}>
      <div
        className="flex h-2 w-full overflow-hidden rounded-full bg-muted/40"
        title={`n=${total}`}
      >
        {segments.map((s, i) => (
          <div
            key={s.label}
            style={{
              width: `${(s.count / total) * 100}%`,
              backgroundColor: PALETTE[i % PALETTE.length],
            }}
            title={`${s.label}: ${s.count}`}
          />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
        {segments.map((s, i) => (
          <span key={s.label} className="inline-flex items-center gap-1">
            <span
              className="size-2 shrink-0 rounded-[3px]"
              style={{ backgroundColor: PALETTE[i % PALETTE.length] }}
            />
            <span className={cn('tabular-nums', s.label === mode && 'font-[600] text-foreground')}>
              {s.label} {s.count}
            </span>
          </span>
        ))}
      </div>
    </div>
  )
}
