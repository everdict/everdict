import { Scale } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { parseMetricLabel } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'

// Metric-label atom — renders the hierarchical judge metric vocabulary (`judge[:<judgeId>][:<criterionId>]`,
// docs/architecture/eval-domain-model.md) as a judge tag + criterion badge instead of the raw colon string.
// Non-judge metrics render as plain mono text. siblings = the metric labels co-present on the same scorecard
// (disambiguates the 2-segment form: registered-judge overall vs inline-judge criterion). Full raw label + role on hover.

// Criterion badge — the bare criterion marker; also used standalone for rows already nested under their judge's overall row.
export function CriterionBadge({
  criterionId,
  className,
}: {
  criterionId: string
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-md bg-secondary px-1.5 py-0.5 font-mono text-[10.5px] font-[510] leading-none text-secondary-foreground ring-1 ring-inset ring-border',
        className
      )}
    >
      {criterionId}
    </span>
  )
}

export function MetricLabel({
  metric,
  siblings,
  className,
}: {
  metric: string
  siblings?: readonly string[]
  className?: string
}) {
  const t = useTranslations('ui')
  const p = parseMetricLabel(metric, siblings)
  if (p.kind === 'plain') return <span className={cn('font-mono', className)}>{p.metric}</span>
  const hint =
    p.kind === 'judge-overall'
      ? p.judgeId
        ? t('metricJudgeOverallHint', { id: p.judgeId })
        : t('metricJudgeOverallInlineHint')
      : p.judgeId
        ? t('metricJudgeCriterionHint', { criterion: p.criterionId, id: p.judgeId })
        : t('metricJudgeCriterionInlineHint', { criterion: p.criterionId })
  return (
    <span
      title={`${hint} · ${metric}`}
      className={cn('inline-flex min-w-0 items-center gap-1.5', className)}
    >
      {/* 'judge' is the metric-namespace domain token (matches the hardcoded table-header vocabulary) — the hint carries the localized meaning. */}
      <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-muted/40 px-1.5 py-0.5 text-[10.5px] font-[510] leading-none text-muted-foreground">
        <Scale className="size-3 shrink-0" />
        judge
      </span>
      {p.judgeId && <span className="truncate font-mono">{p.judgeId}</span>}
      {p.kind === 'judge-criterion' && (
        <>
          <span className="shrink-0 text-faint">›</span>
          <CriterionBadge criterionId={p.criterionId} />
        </>
      )}
    </span>
  )
}
