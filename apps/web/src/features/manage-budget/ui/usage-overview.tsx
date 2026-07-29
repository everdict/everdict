'use client'

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'

import type { TenantUsage, UsageItem } from '@/entities/usage'
import { fmtTokens, fmtUsd } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import {
  BarChart,
  MAX_SERIES,
  OTHER_COLOR,
  seriesColorAt,
  type ChartSeries,
} from '@/shared/ui/charts'
import { StatCard } from '@/shared/ui/stat-card'
import { Table, TBody, TD, TH, THead, TR } from '@/shared/ui/table'
import { InfoTip } from '@/shared/ui/tooltip'

type GroupBy = 'activity' | 'model'
// The dimension the chart plots. Cost and tokens are metered on the same rows, so this is a lens, not a refetch.
type Metric = 'usd' | 'tokens'
const RANGES = [7, 30, 90] as const
type RangeDays = (typeof RANGES)[number]

const metricOf = (row: UsageItem, metric: Metric): number =>
  metric === 'usd' ? row.usd : row.tokens

function utcToday(): string {
  return new Date().toISOString().slice(0, 10)
}

// The last `count` UTC days ending today — zero-filled axis, so quiet days stay visible as gaps in spend.
function lastDays(count: number): string[] {
  const out: string[] = []
  const end = new Date(`${utcToday()}T00:00:00Z`).getTime()
  for (let i = count - 1; i >= 0; i--)
    out.push(new Date(end - i * 86_400_000).toISOString().slice(0, 10))
  return out
}

function Segmented<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
}) {
  return (
    <div className="flex items-center gap-0.5 rounded-md border p-0.5">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded px-2 py-0.5 text-[12px] font-[510] transition-colors',
            o.value === value
              ? 'bg-accent text-foreground'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// Metered-usage dashboard (the billing view): headline tiles, a daily chart with metric + range + group-by filters,
// and the all-time (source × model) breakdown table. Read-only — the meter never blocks; caps live in BudgetManager.
export function UsageOverview({ metered }: { metered: TenantUsage }) {
  const t = useTranslations('manageBudget')
  const [metric, setMetric] = useState<Metric>('usd')
  const [range, setRange] = useState<RangeDays>(30)
  const [groupBy, setGroupBy] = useState<GroupBy>('activity')
  const fmtMetric = metric === 'usd' ? fmtUsd : fmtTokens
  const dailyTitle = metric === 'usd' ? t('dailyTitle') : t('dailyTokensTitle')

  const monthPrefix = utcToday().slice(0, 7)
  const mtdUsd = useMemo(
    () => metered.daily.filter((d) => d.day.startsWith(monthPrefix)).reduce((s, d) => s + d.usd, 0),
    [metered.daily, monthPrefix]
  )

  const days = useMemo(() => lastDays(range), [range])

  const sourceLabel = (s: UsageItem['source']) =>
    s === 'harness' ? t('sourceHarness') : s === 'judge' ? t('sourceJudge') : t('sourceAgent')

  // Series identity comes from ALL daily data (not the window), so switching 7d/30d/90d never repaints survivors.
  const { series, values } = useMemo(() => {
    const dayIndex = new Map(days.map((d, i) => [d, i]))
    const valueOf = (row: TenantUsage['daily'][number]) => metricOf(row, metric)
    const srcLabel = (s: UsageItem['source']) =>
      s === 'harness' ? t('sourceHarness') : s === 'judge' ? t('sourceJudge') : t('sourceAgent')
    let defs: {
      key: string
      label: string
      color: string
      match: (row: TenantUsage['daily'][number]) => boolean
    }[]
    if (groupBy === 'activity') {
      const active = (['harness', 'judge', 'agent'] as const).filter((s) =>
        metered.daily.some((d) => d.source === s && valueOf(d) > 0)
      )
      const slots: Record<string, string> = {
        harness: seriesColorAt(0),
        judge: seriesColorAt(1),
        agent: seriesColorAt(2),
      }
      defs = active.map((s) => ({
        key: s,
        label: srcLabel(s),
        color: slots[s] ?? OTHER_COLOR,
        match: (row) => row.source === s,
      }))
    } else {
      const byModel = new Map<string, number>()
      for (const d of metered.daily) byModel.set(d.model, (byModel.get(d.model) ?? 0) + valueOf(d))
      const ranked = [...byModel.entries()]
        .filter(([, total]) => total > 0)
        .sort((a, b) => b[1] - a[1])
        .map(([m]) => m)
      const lead = ranked.slice(0, MAX_SERIES)
      defs = lead.map((m, i) => ({
        key: `model:${m}`,
        label: m === '' ? t('modelUnattributed') : m,
        color: seriesColorAt(i),
        match: (row) => row.model === m,
      }))
      if (ranked.length > lead.length) {
        const leadSet = new Set(lead)
        defs.push({
          key: 'model:__other__',
          label: t('otherSeries'),
          color: OTHER_COLOR,
          match: (row) => !leadSet.has(row.model),
        })
      }
    }
    const matrix = defs.map(() => days.map(() => 0))
    for (const row of metered.daily) {
      const di = dayIndex.get(row.day)
      if (di === undefined) continue
      const si = defs.findIndex((def) => def.match(row))
      const line = si >= 0 ? matrix[si] : undefined
      if (line) line[di] = (line[di] ?? 0) + valueOf(row)
    }
    const chartSeries: ChartSeries[] = defs.map(({ key, label, color }) => ({ key, label, color }))
    return { series: chartSeries, values: matrix }
  }, [metered.daily, days, groupBy, metric, t])

  const periodValue = useMemo(
    () => values.reduce((s, line) => s + line.reduce((a, v) => a + v, 0), 0),
    [values]
  )

  // Itemized (source × model) breakdown — drop empty/legacy-unattributed lines, heaviest spend first.
  const items = metered.items
    .filter((i) => i.usd > 0 || i.tokens > 0 || i.evaluations > 0)
    .sort((a, b) => b.usd - a.usd)

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <h3 className="flex items-center gap-1.5 text-[13px] font-[560] text-foreground">
          {t('meteredTitle')}
          <InfoTip content={t('meteredTip')} />
        </h3>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label={t('mtdCost')} value={fmtUsd(mtdUsd)} hint={monthPrefix} tone="primary" />
        <StatCard label={t('meteredCost')} value={fmtUsd(metered.usd)} hint={t('allTimeHint')} />
        <StatCard
          label={t('meteredTokens')}
          value={fmtTokens(metered.tokens)}
          hint={t('allTimeHint')}
        />
        <StatCard
          label={t('meteredEvaluations')}
          value={metered.evaluations.toLocaleString()}
          hint={t('allTimeHint')}
        />
      </div>

      {/* filter row — scopes the chart below it (which number first, then the window, then the split) */}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Segmented
          value={metric}
          onChange={setMetric}
          options={[
            { value: 'usd' as const, label: t('metricCost') },
            { value: 'tokens' as const, label: t('metricTokens') },
          ]}
        />
        <Segmented
          value={range}
          onChange={setRange}
          options={RANGES.map((d) => ({ value: d, label: t('rangeDays', { days: d }) }))}
        />
        <Segmented
          value={groupBy}
          onChange={setGroupBy}
          options={[
            { value: 'activity' as const, label: t('groupActivity') },
            { value: 'model' as const, label: t('groupModel') },
          ]}
        />
        <span className="ml-auto text-[12px] text-muted-foreground">
          {t('periodTotal', { days: range })}{' '}
          <span className="font-[560] tabular-nums text-foreground">{fmtMetric(periodValue)}</span>
        </span>
      </div>

      <div className="rounded-lg border bg-card p-4 shadow-raise">
        <div className="mb-2 flex items-center gap-1.5">
          <h4 className="text-[12px] font-[560] text-muted-foreground">{dailyTitle}</h4>
          <InfoTip content={metric === 'usd' ? t('dailyTip') : t('dailyTokensTip')} />
        </div>
        <BarChart
          x={days}
          series={series}
          values={values}
          stacked
          showTotal
          formatValue={fmtMetric}
          formatX={(day) => day.slice(5).replace('-', '/')}
          ariaLabel={dailyTitle}
          emptyLabel={t('chartEmpty')}
        />
      </div>

      {items.length > 0 && (
        <div className="space-y-1.5 pt-1">
          <h4 className="flex items-center gap-1.5 text-[12px] font-[560] text-muted-foreground">
            {t('breakdownTitle')}
            <InfoTip content={t('breakdownTip')} />
          </h4>
          <Table>
            <THead>
              <TR>
                <TH>{t('colModel')}</TH>
                <TH>{t('colActivity')}</TH>
                <TH className="text-right">{t('colCost')}</TH>
                <TH className="text-right">{t('colTokens')}</TH>
                <TH className="text-right">{t('colEvaluations')}</TH>
              </TR>
            </THead>
            <TBody>
              {items.map((i) => (
                <TR key={`${i.source} ${i.model}`}>
                  <TD className="font-[510]">{i.model || t('modelUnattributed')}</TD>
                  <TD className="text-muted-foreground">{sourceLabel(i.source)}</TD>
                  <TD className="text-right tabular-nums">{fmtUsd(i.usd)}</TD>
                  <TD className="text-right tabular-nums">{fmtTokens(i.tokens)}</TD>
                  <TD className="text-right tabular-nums">{i.evaluations.toLocaleString()}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      )}
    </div>
  )
}
