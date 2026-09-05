import { cn } from '@/shared/lib/utils'

// The atom that shows a categorical (tier/string) metric's label distribution as a one-line segmented bar plus a legend. Each segment's width is
// proportional to its frequency, and the mode is emphasised. A pure presentation component — it takes raw segments so it depends on no entity (the FSD shared layer).
// Colours cycle through a fixed palette in label order (label → colour is stable, so the same label sits in the same position across scorecards and reads consistently).
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
