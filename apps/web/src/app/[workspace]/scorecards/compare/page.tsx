import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import { ComparePicker, type CompareOption } from '@/features/compare-scorecards'
import { scorecardDiffSchema, scorecardsSchema, type ScorecardDiff } from '@/entities/scorecard'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { fmtMetricLabel, fmtPct } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { Callout } from '@/shared/ui/callout'
import { Card } from '@/shared/ui/card'
import { ModelChip } from '@/shared/ui/chip'
import { EmptyState } from '@/shared/ui/empty-state'
import { MetricLabel } from '@/shared/ui/metric-label'
import { PageHeader } from '@/shared/ui/page-header'
import { SectionHeader } from '@/shared/ui/section-header'
import { Table, TBody, TD, TH, THead, TR } from '@/shared/ui/table'
import { InfoTip } from '@/shared/ui/tooltip'

export const dynamic = 'force-dynamic'

function delta(n: number): string {
  const arrow = n > 0 ? '▲' : n < 0 ? '▼' : '–'
  return `${arrow} ${n > 0 ? '+' : ''}${n.toFixed(2)}`
}

// One side (baseline/candidate) header — links to the scorecard detail + model-used chip.
function SideRef({
  workspace,
  label,
  id,
  model,
}: {
  workspace: string
  label: string
  id: string
  model?: string
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-[11px] uppercase tracking-wide text-faint">{label}</span>
      <Link
        href={`/${workspace}/scorecards/${encodeURIComponent(id)}`}
        className="font-mono text-[12px] font-[510] text-link transition-colors hover:text-foreground"
        title={id}
      >
        {id.slice(0, 8)}
      </Link>
      {model && <ModelChip>{model}</ModelChip>}
    </span>
  )
}

export default async function CompareScorecardsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>
  searchParams: Promise<{ baseline?: string; candidate?: string }>
}) {
  const { workspace } = await params
  const { baseline, candidate } = await searchParams
  const ctx = await authContext()
  const t = await getTranslations('scorecardsPage')

  // Comparison uses only completed scorecards (incomplete ones can't diff).
  let options: CompareOption[] = []
  let baselineModel: string | undefined
  let candidateModel: string | undefined
  try {
    const all = scorecardsSchema.parse(await controlPlane.listScorecards(ctx))
    options = all
      .filter((s) => s.status === 'succeeded')
      .map((s) => ({
        id: s.id,
        label: `${s.dataset.id}@${s.dataset.version} → ${s.harness.id}@${s.harness.version}`,
      }))
    // Each side's model (from the selected scorecard record) — shown alongside the header.
    const byId = new Map(all.map((s) => [s.id, s]))
    baselineModel = baseline ? byId.get(baseline)?.models?.primary : undefined
    candidateModel = candidate ? byId.get(candidate)?.models?.primary : undefined
  } catch {
    // Even if the list fails, the page still shows guidance
  }

  let diff: ScorecardDiff | undefined
  let error: string | undefined
  if (baseline && candidate) {
    try {
      diff = scorecardDiffSchema.parse(await controlPlane.diffScorecards(ctx, baseline, candidate))
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
  }

  return (
    <div className="space-y-7">
      <div className="space-y-3">
        <Link
          href={`/${workspace}/scorecards`}
          className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
          {t('backToList')}
        </Link>
        <PageHeader title={t('compareTitle')} description={t('compareDescription')} />
      </div>

      {options.length < 2 ? (
        <EmptyState title={t('needTwoTitle')} hint={t('needTwoHint')} />
      ) : (
        <Card className="p-4">
          <ComparePicker options={options} baseline={baseline} candidate={candidate} />
        </Card>
      )}

      {error && <Callout tone="danger">{t('compareError', { error })}</Callout>}

      {diff && (
        <div className="space-y-7">
          <section className="space-y-2.5">
            <SectionHeader title={t('metricChangesTitle')} />
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <SideRef
                workspace={workspace}
                label="baseline"
                id={diff.baseline}
                model={baselineModel}
              />
              <span className="text-faint">→</span>
              <SideRef
                workspace={workspace}
                label="candidate"
                id={diff.candidate}
                model={candidateModel}
              />
            </div>
            <Table>
              <THead>
                <tr>
                  <TH>metric</TH>
                  <TH className="text-right">baseline</TH>
                  <TH className="text-right">candidate</TH>
                  <TH className="text-right">Δ</TH>
                </tr>
              </THead>
              <TBody>
                {diff.metrics.map((m) => (
                  <TR key={m.metric}>
                    <TD className="text-[12px] font-[510]">
                      <MetricLabel metric={m.metric} siblings={diff.metrics.map((x) => x.metric)} />
                    </TD>
                    <TD className="text-right font-mono text-[12px] tabular-nums text-muted-foreground">
                      {m.baselineMean.toFixed(2)}
                    </TD>
                    <TD className="text-right font-mono text-[12px] tabular-nums">
                      {m.candidateMean.toFixed(2)}
                    </TD>
                    <TD
                      className={cn(
                        'text-right font-mono text-[12px] tabular-nums',
                        m.delta === 0
                          ? 'text-muted-foreground'
                          : m.delta > 0
                            ? 'font-[510] text-[var(--color-success)]'
                            : 'font-[510] text-destructive'
                      )}
                    >
                      {delta(m.delta)}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </section>

          {/* When either side ran trials, the pass-transition lists are last-trial-noisy — show the statistically-gated
              (two-proportion) regressions instead. Otherwise fall back to the single-run pass-transition lists. */}
          {diff.trials ? (
            <section className="space-y-3">
              <SectionHeader
                title={t('trialGateTitle')}
                action={
                  <InfoTip content={t('trialGateInfo', { z: diff.trials.zThreshold.toFixed(2) })} />
                }
              />
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <TrialDeltaList
                  title={t('regressionsTitle')}
                  tone="danger"
                  items={diff.trials.regressions}
                  empty={t('noTrialRegressions')}
                />
                <TrialDeltaList
                  title={t('improvementsTitle')}
                  tone="success"
                  items={diff.trials.improvements}
                  empty={t('noTrialImprovements')}
                />
              </div>
            </section>
          ) : (
            <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <DeltaList
                title={t('regressionsTitle')}
                tone="danger"
                items={diff.regressions}
                empty={t('noRegressions')}
                siblingMetrics={diff.metrics.map((m) => m.metric)}
              />
              <DeltaList
                title={t('improvementsTitle')}
                tone="success"
                items={diff.improvements}
                empty={t('noImprovements')}
                siblingMetrics={diff.metrics.map((m) => m.metric)}
              />
            </section>
          )}
        </div>
      )}
    </div>
  )
}

// A statistically-gated trial delta list — baseline vs candidate pass RATE over N trials + the two-proportion z.
// Every item here already cleared the significance gate on the server, so the count IS the significant set.
function TrialDeltaList({
  title,
  tone,
  items,
  empty,
}: {
  title: string
  tone: 'danger' | 'success'
  items: NonNullable<ScorecardDiff['trials']>['regressions']
  empty: string
}) {
  const sorted = [...items].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
  return (
    <Card className="space-y-2.5 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-[13px] font-[560]">{title}</h2>
        <Badge tone={tone}>{items.length}</Badge>
      </div>
      {sorted.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">{empty}</p>
      ) : (
        <ul className="divide-y divide-border/70">
          {sorted.map((d) => (
            <li
              key={d.caseId}
              className="flex items-center justify-between gap-2 py-1.5 first:pt-0 last:pb-0"
            >
              <span className="min-w-0 truncate font-mono text-[12px]">{d.caseId}</span>
              <span className="flex shrink-0 items-center gap-2 font-mono text-[12px] tabular-nums">
                <span className="text-muted-foreground">
                  {fmtPct(d.baselineRate)} → {fmtPct(d.candidateRate)}
                </span>
                <span
                  className={cn(
                    'font-[510]',
                    tone === 'danger' ? 'text-destructive' : 'text-[var(--color-success)]'
                  )}
                >
                  z {d.z.toFixed(2)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

function DeltaList({
  title,
  tone,
  items,
  empty,
  siblingMetrics,
}: {
  title: string
  tone: 'danger' | 'success'
  items: ScorecardDiff['regressions']
  empty: string
  siblingMetrics?: readonly string[] // judge-metric disambiguation context (the diff's full metric set)
}) {
  // Cases with the largest change first — put the notable regressions/improvements on top.
  const sorted = [...items].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
  return (
    <Card className="space-y-2.5 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-[13px] font-[560]">{title}</h2>
        <Badge tone={tone}>{items.length}</Badge>
      </div>
      {sorted.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">{empty}</p>
      ) : (
        <ul className="divide-y divide-border/70">
          {sorted.map((d) => (
            <li
              key={`${d.caseId}:${d.metric}`}
              className="flex items-center justify-between gap-2 py-1.5 first:pt-0 last:pb-0"
            >
              <span className="min-w-0 truncate font-mono text-[12px]" title={d.metric}>
                {d.caseId}
                <span className="text-faint"> · {fmtMetricLabel(d.metric, siblingMetrics)}</span>
              </span>
              <span className="flex shrink-0 items-center gap-2 font-mono text-[12px] tabular-nums">
                <span className="text-muted-foreground">
                  {d.baseline} → {d.candidate}
                </span>
                <span
                  className={cn(
                    'font-[510]',
                    tone === 'danger' ? 'text-destructive' : 'text-[var(--color-success)]'
                  )}
                >
                  {delta(d.delta)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
