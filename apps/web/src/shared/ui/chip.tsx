import type { ReactNode } from 'react'
import { Boxes, Cpu, Database, Gavel, ListFilter, Server, Tag } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { fmtMetricLabel, fmtPct } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'

// Metric summary chip — name (faint) + mean + optional pass rate. Same across lists/per-harness.
// Judge metrics render human-readably ('judge <id> › <criterion>'); siblings disambiguate the 2-segment
// judge form (raw label on hover).
export function MetricChip({
  metric,
  mean,
  passRate,
  siblings,
}: {
  metric: string
  mean: number
  passRate?: number | null
  siblings?: readonly string[]
}) {
  return (
    <code
      title={metric}
      className="inline-flex items-center gap-1 rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px]"
    >
      <span className="text-faint">{fmtMetricLabel(metric, siblings)}</span>
      <span className="tabular-nums text-foreground/85">{mean.toFixed(2)}</span>
      {passRate != null && <span className="tabular-nums text-faint">· {fmtPct(passRate)}</span>}
    </code>
  )
}

// Model chip — the LLM identifier the harness used/declared. Prefix a type-identifying icon (Cpu) (hard to tell apart from text alone).
// primary=bg-secondary (emphasis), muted=observed/declared (faint). Uniform globally.
export function ModelChip({ children, muted }: { children: ReactNode; muted?: boolean }) {
  return (
    <code
      className={cn(
        'inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 font-mono text-[11px]',
        muted ? 'bg-muted/40 text-muted-foreground' : 'bg-secondary text-secondary-foreground'
      )}
    >
      <Cpu
        className={cn('size-3 shrink-0', muted ? 'text-muted-foreground/70' : 'text-[#fc9a6e]')}
      />
      {children}
    </code>
  )
}

// Runtime chip — the execution infra the workload runs on (registered runtime id | self:* runner | 'default backend'). Type distinguished by the icon (Server).
export function RuntimeChip({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
      <Server className="size-3 shrink-0 text-[#6ec6a8]" />
      {label}
    </span>
  )
}

// Partial-run chip — marks a scorecard that ran only a subset of the dataset (selected/total). Not rendered on a full run.
export function SubsetChip({ selected, total }: { selected: number; total: number }) {
  const t = useTranslations('ui')
  return (
    <span
      className="inline-flex items-center gap-1 rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-muted-foreground"
      title={t('subsetTitle', { total, selected })}
    >
      <ListFilter className="size-3 shrink-0 text-[#e2b96b]" />
      {t('subsetLabel', { selected, total })}
    </span>
  )
}

// Version tag chip — a free-form label attached when versions are hard to tell apart by number alone (out-of-spec registry metadata). Uniform globally.
// trailing (delete ✕, etc.) is injected by the editing surface — the chip itself is display-only.
export function VersionTagChip({
  children,
  trailing,
}: {
  children: ReactNode
  trailing?: ReactNode
}) {
  return (
    <span className="inline-flex items-center gap-1 rounded border border-border bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground">
      <Tag className="size-3 shrink-0 text-[#b78de8]" />
      {children}
      {trailing}
    </span>
  )
}

// id@version reference — identifies datasets/harnesses/judges in the same format (@version is faint).
// If kind is given, prefix a type icon for visual distinction (dataset=Database blue, harness=Boxes indigo, judge=Gavel gold).
const ENTITY_META = {
  dataset: { icon: Database, tint: 'text-[#7cc0ff]' },
  harness: { icon: Boxes, tint: 'text-[#9aa2ec]' },
  judge: { icon: Gavel, tint: 'text-[#d9a55f]' },
} as const

export function EntityRef({
  id,
  version,
  kind,
}: {
  id: string
  version?: string
  kind?: keyof typeof ENTITY_META
}) {
  const meta = kind ? ENTITY_META[kind] : null
  return (
    <span className="inline-flex min-w-0 items-center gap-1 font-mono">
      {meta && <meta.icon className={cn('size-3.5 shrink-0', meta.tint)} strokeWidth={1.75} />}
      <span className="truncate">
        {id}
        {version && <span className="text-faint">@{version}</span>}
      </span>
    </span>
  )
}
