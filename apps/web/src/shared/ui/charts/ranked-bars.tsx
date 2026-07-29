'use client'

import type { ReactNode } from 'react'

import { cn } from '@/shared/lib/utils'

import { SERIES_SLOTS } from './palette'

// Horizontal ranked bars — magnitude plus identity, where the identity is a long label (a harness id, a
// model name) that a column chart would have to rotate or truncate. One series, so every bar takes the SAME
// hue: shading each bar by its own size would double-encode length as color and burn the free channel.

export interface RankedRow {
  key: string
  label: string
  value?: number
  /** Optional secondary count shown after the value (how many records the bar aggregates). */
  count?: number
}

export function RankedBars({
  rows,
  formatValue,
  domain,
  renderValue,
  countLabel,
  emptyLabel,
  selectedKey,
  onSelect,
}: {
  rows: RankedRow[]
  formatValue: (v: number) => string
  /** Pin the scale — `{min: 0, max: 1}` for a ratio, so bar length always means the same thing. */
  domain?: { min: number; max: number }
  /** Override how the value is printed (e.g. health-toned pass rates); falls back to formatValue. */
  renderValue?: (row: RankedRow) => ReactNode
  countLabel?: (count: number) => string
  emptyLabel: string
  selectedKey?: string
  onSelect?: (row: RankedRow) => void
}) {
  const values = rows.map((r) => r.value).filter((v): v is number => typeof v === 'number')
  if (values.length === 0)
    return (
      <div className="flex h-24 items-center justify-center text-[13px] text-muted-foreground">
        {emptyLabel}
      </div>
    )

  // Scale to the largest bar (or the pinned domain), never to "is this value below 1?".
  const top = domain ? domain.max : Math.max(...values)
  const base = domain ? domain.min : Math.min(0, ...values)
  const span = top - base || 1
  const color = SERIES_SLOTS[0]

  return (
    <div className="space-y-1.5">
      {rows.map((row) => {
        const v = row.value
        // A negative value can't be drawn from this baseline; the printed value still carries it.
        const ratio = typeof v === 'number' ? Math.max(0, Math.min(1, (v - base) / span)) : 0
        const interactive = Boolean(onSelect)
        return (
          <div
            key={row.key}
            className={cn(
              'flex items-center gap-3 rounded-md px-1.5 py-0.5 transition-colors',
              interactive && 'cursor-pointer hover:bg-elevated',
              selectedKey === row.key && 'bg-elevated'
            )}
            {...(interactive
              ? {
                  role: 'button',
                  tabIndex: 0,
                  onClick: () => onSelect?.(row),
                  onKeyDown: (e: React.KeyboardEvent) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      onSelect?.(row)
                    }
                  },
                }
              : {})}
          >
            <span className="w-48 shrink-0 truncate text-[13px] font-[510]" title={row.label}>
              {row.label}
            </span>
            <div className="relative h-5 flex-1 overflow-hidden rounded bg-secondary/50">
              <div
                className="h-full rounded"
                style={{ width: `${ratio * 100}%`, background: color }}
              />
            </div>
            <span className="w-16 shrink-0 text-right">
              {renderValue ? (
                renderValue(row)
              ) : typeof v === 'number' ? (
                formatValue(v)
              ) : (
                <span className="text-faint">–</span>
              )}
            </span>
            {countLabel && (
              <span className="w-10 shrink-0 text-right text-[11px] text-faint">
                {typeof row.count === 'number' ? countLabel(row.count) : ''}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}
