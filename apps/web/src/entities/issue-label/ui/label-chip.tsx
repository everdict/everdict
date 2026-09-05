import { cn } from '@/shared/lib/utils'

import type { IssueLabel, IssueLabelColor } from '../model/schema'

// A Linear-style label chip — a colour dot plus the name. The colour is a CLOSED vocabulary (contracts' ISSUE_LABEL_COLORS) mapped to theme
// tokens here: had a hex been stored, anyone could have made a label invisible in dark mode. The same rule as the charts —
// no invented colours.
//
// `bg-<token>/x` does not generate a utility for our @theme inline colours (unlike shadcn's destructive) —
// so the dot reads the CSS variable directly (the same workaround as shared/ui/badge).
const DOT: Record<IssueLabelColor, string> = {
  gray: 'var(--color-muted-foreground)',
  purple: 'var(--chart-4)',
  blue: 'var(--color-primary)',
  teal: 'var(--chart-5)',
  green: 'var(--color-success)',
  yellow: 'var(--color-warning)',
  orange: 'var(--chart-3)',
  red: 'var(--color-destructive)',
  pink: 'var(--chart-2)',
}

export function LabelDot({ color, className }: { color: IssueLabelColor; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('size-2 shrink-0 rounded-full', className)}
      style={{ backgroundColor: DOT[color] }}
    />
  )
}

export function LabelChip({ label, className }: { label: IssueLabel; className?: string }) {
  return (
    <span
      title={label.description ?? label.name}
      className={cn(
        'inline-flex min-w-0 items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-[11.5px] text-muted-foreground',
        className
      )}
    >
      <LabelDot color={label.color} />
      <span className="truncate">{label.name}</span>
    </span>
  )
}

// It joins the ids an issue holds to the registry and draws them as chips. An id whose definition is gone is not rendered — deleting a label
// detaches its id from the issues too, so it does not arise on the normal path, and if it did it is a pointer with nothing to show.
export function IssueLabelChips({
  labelIds,
  directory,
  className,
}: {
  labelIds: string[]
  directory: Record<string, IssueLabel>
  className?: string
}) {
  const resolved = labelIds.map((id) => directory[id]).filter((l): l is IssueLabel => l !== undefined)
  if (resolved.length === 0) return null
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1', className)}>
      {resolved.map((label) => (
        <LabelChip key={label.id} label={label} />
      ))}
    </span>
  )
}
