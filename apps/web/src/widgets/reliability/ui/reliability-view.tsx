import { getTranslations } from 'next-intl/server'

import { gateAuditSchema, opsReportSchema } from '@/entities/ops-report'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { fmtPct } from '@/shared/lib/format'
import { Callout } from '@/shared/ui/callout'
import { DistributionBar } from '@/shared/ui/distribution-bar'
import { StatCard } from '@/shared/ui/stat-card'

// The reliability dashboard's body — TWO reads (ops report + gate audit), both derived server-side from the
// workspace's own ledger. The load-bearing rendering rule is ABSENCE: a rate whose denominator was zero is
// "not measured", never a 0% bar — the trust-kernel contract carried to the pixel.
export async function ReliabilityView({ window }: { window?: { from?: string; to?: string } }) {
  const t = await getTranslations('reliabilityPage')
  const ctx = await authContext()

  let report
  let audit
  try {
    const [rawReport, rawAudit] = await Promise.all([
      controlPlane.getOpsReport(ctx, window),
      controlPlane.getGateAudit(ctx, window),
    ])
    report = opsReportSchema.parse(rawReport)
    audit = gateAuditSchema.parse(rawAudit)
  } catch (e) {
    return (
      <Callout tone="danger">
        {t('connectError', { error: e instanceof Error ? e.message : String(e) })}
      </Callout>
    )
  }

  const rate = (value: number | undefined, invert = false) => ({
    value: value === undefined ? t('notMeasured') : fmtPct(value),
    tone:
      value === undefined
        ? ('default' as const)
        : (invert ? value > 0.05 : value < 0.95)
          ? ('danger' as const)
          : ('success' as const),
  })
  const infra = rate(report.rates.infraFailure, true)
  const unmeasured = rate(report.rates.unmeasured, true)
  const seal = rate(report.rates.traceComplete)

  return (
    <div className="space-y-7">
      <div className="grid grid-cols-2 gap-3 @[700px]:grid-cols-4">
        <StatCard
          label={t('tiles.infraFailure')}
          value={infra.value}
          tone={infra.tone}
          hint={t('tiles.infraFailureHint')}
        />
        <StatCard
          label={t('tiles.unmeasured')}
          value={unmeasured.value}
          tone={unmeasured.tone}
          hint={t('tiles.unmeasuredHint')}
        />
        <StatCard
          label={t('tiles.traceComplete')}
          value={seal.value}
          tone={seal.tone}
          hint={t('tiles.traceCompleteHint')}
        />
        <StatCard
          label={t('tiles.gates')}
          value={`${audit.decisions.pass} / ${audit.decisions.block} / ${audit.decisions.notComparable}`}
          hint={t('tiles.gatesHint')}
        />
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-medium">{t('caseOutcomes.title')}</h2>
        <p className="text-[12px] text-muted-foreground">{t('caseOutcomes.description')}</p>
        <DistributionBar
          segments={[
            { label: t('caseOutcomes.verdicted'), count: report.cases.verdicted },
            { label: t('caseOutcomes.unmeasured'), count: report.cases.unmeasured },
            { label: t('caseOutcomes.infraFailed'), count: report.cases.infraFailed },
            { label: t('caseOutcomes.cancelled'), count: report.cases.cancelled },
          ].filter((s) => s.count > 0)}
        />
        <div className="text-[12px] text-muted-foreground">
          {t('caseOutcomes.executed', { executed: report.cases.executed })}
          {report.cases.requested !== undefined &&
            ` · ${t('caseOutcomes.requested', { requested: report.cases.requested })}`}
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium">{t('evidence.title')}</h2>
        <p className="text-[12px] text-muted-foreground">{t('evidence.description')}</p>
        <DistributionBar
          segments={[
            { label: t('evidence.complete'), count: report.evidence.trace.complete },
            { label: t('evidence.partial'), count: report.evidence.trace.partial },
            { label: t('evidence.deferred'), count: report.evidence.trace.deferred },
            { label: t('evidence.missing'), count: report.evidence.trace.missing },
          ].filter((s) => s.count > 0)}
        />
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium">{t('gates.title')}</h2>
        <p className="text-[12px] text-muted-foreground">
          {audit.overrideRate !== undefined
            ? t('gates.overrideRate', { rate: fmtPct(audit.overrideRate) })
            : t('gates.noBlocks')}
        </p>
        {audit.overrides.entries.length > 0 && (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b bg-muted/30 text-left text-[11px] uppercase tracking-wide text-faint">
                  <th className="px-3 py-2 font-[510]">{t('gates.candidate')}</th>
                  <th className="px-3 py-2 font-[510]">{t('gates.by')}</th>
                  <th className="px-3 py-2 font-[510]">{t('gates.reason')}</th>
                  <th className="px-3 py-2 font-[510]">{t('gates.at')}</th>
                </tr>
              </thead>
              <tbody>
                {audit.overrides.entries.map((o) => (
                  <tr key={o.gateId} className="border-b last:border-0">
                    <td className="px-3 py-2 font-mono text-[12px]">{o.candidate}</td>
                    <td className="px-3 py-2">{o.by}</td>
                    <td className="px-3 py-2">{o.reason}</td>
                    <td className="px-3 py-2 tabular-nums text-muted-foreground">
                      {new Date(o.at).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
