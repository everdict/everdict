import { getTranslations } from 'next-intl/server'

import { tenantUsageSchema, type TenantUsage } from '@/entities/usage'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Callout } from '@/shared/ui/callout'
import { PageHeader } from '@/shared/ui/page-header'
import { SectionHeader } from '@/shared/ui/section-header'
import { StatCard } from '@/shared/ui/stat-card'
import { Table, TBody, TD, TH, THead, TR } from '@/shared/ui/table'

export const dynamic = 'force-dynamic'

const usd = (n: number) => `$${n.toFixed(2)}`
const num = (n: number) => n.toLocaleString()

// Billing usage — the workspace's metered LLM cost for the billable surface (orchestration + verdict), split by source.
export default async function UsagePage() {
  const t = await getTranslations('usagePage')
  const { ctx } = await currentPrincipal()

  let usage: TenantUsage | undefined
  let error: string | undefined
  try {
    usage = tenantUsageSchema.parse(await controlPlane.getUsage(ctx))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  return (
    <div className="space-y-6">
      <PageHeader title={t('title')} description={t('description')} />
      {error || !usage ? (
        <Callout tone="danger">{t('loadError', { error: error ?? '' })}</Callout>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3">
            <StatCard label={t('cost')} value={usd(usage.usd)} />
            <StatCard label={t('tokens')} value={num(usage.tokens)} />
            <StatCard label={t('evaluations')} value={num(usage.evaluations)} />
          </div>

          <section className="space-y-2.5">
            <SectionHeader title={t('bySourceTitle')} />
            <Table>
              <THead>
                <tr>
                  <TH>{t('source')}</TH>
                  <TH className="text-right">{t('cost')}</TH>
                  <TH className="text-right">{t('tokens')}</TH>
                  <TH className="text-right">{t('evaluations')}</TH>
                </tr>
              </THead>
              <TBody>
                {(
                  [
                    ['sourceHarness', usage.bySource.harness],
                    ['sourceJudge', usage.bySource.judge],
                  ] as const
                ).map(([key, s]) => (
                  <TR key={key}>
                    <TD className="font-[510]">{t(key)}</TD>
                    <TD className="text-right font-mono text-[12px] tabular-nums">{usd(s.usd)}</TD>
                    <TD className="text-right font-mono text-[12px] tabular-nums text-muted-foreground">
                      {num(s.tokens)}
                    </TD>
                    <TD className="text-right font-mono text-[12px] tabular-nums text-muted-foreground">
                      {num(s.evaluations)}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </section>

          <p className="text-[12px] text-muted-foreground">{t('note')}</p>
        </>
      )}
    </div>
  )
}
