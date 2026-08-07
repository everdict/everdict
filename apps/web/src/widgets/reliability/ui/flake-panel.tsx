import { getTranslations } from 'next-intl/server'

import { flakeIndexSchema } from '@/entities/ops-report'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { fmtPct } from '@/shared/lib/format'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { Link } from '@/shared/ui/link'

// Cross-batch flake, per dataset. WHICH dataset is a URL filter (a pasted link opens the same list); the
// panel is advisory only — the server ranks, nothing auto-quarantines.
export async function FlakePanel({ workspace, dataset }: { workspace: string; dataset?: string }) {
  const t = await getTranslations('reliabilityPage')
  const ctx = await authContext()

  let datasets: Array<{ id: string }> = []
  try {
    datasets = (await controlPlane.listDatasets<Array<{ id: string }>>(ctx)) ?? []
  } catch {
    // the chip row degrades to nothing — the table below still answers for an explicit ?dataset=
  }

  let flake
  if (dataset) {
    try {
      flake = flakeIndexSchema.parse(await controlPlane.getScorecardFlake(ctx, dataset))
    } catch (e) {
      return (
        <Callout tone="danger">
          {t('connectError', { error: e instanceof Error ? e.message : String(e) })}
        </Callout>
      )
    }
  }

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-medium">{t('flake.title')}</h2>
        <p className="mt-1 text-[12px] text-muted-foreground">{t('flake.description')}</p>
      </div>
      {datasets.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {[...new Set(datasets.map((d) => d.id))].map((id) => (
            <Link
              key={id}
              href={`/${workspace}/reliability?dataset=${encodeURIComponent(id)}`}
              className={
                id === dataset
                  ? 'rounded-full border border-[var(--color-link)] px-2.5 py-0.5 text-[12px] text-[var(--color-link)]'
                  : 'rounded-full border px-2.5 py-0.5 text-[12px] text-muted-foreground hover:border-border-strong'
              }
            >
              {id}
            </Link>
          ))}
        </div>
      )}
      {dataset === undefined ? (
        <EmptyState title={t('flake.pickDataset')} />
      ) : flake && flake.entries.length === 0 ? (
        <EmptyState
          title={t('flake.stable')}
          hint={t('flake.observedKeys', { count: flake.observedKeys })}
        />
      ) : (
        flake && (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b bg-muted/30 text-left text-[11px] uppercase tracking-wide text-faint">
                  <th className="px-3 py-2 font-[510]">{t('flake.case')}</th>
                  <th className="px-3 py-2 font-[510]">{t('flake.harness')}</th>
                  <th className="px-3 py-2 font-[510]">{t('flake.runtime')}</th>
                  <th className="px-3 py-2 text-right font-[510]">{t('flake.record')}</th>
                  <th className="px-3 py-2 text-right font-[510]">{t('flake.score')}</th>
                </tr>
              </thead>
              <tbody>
                {flake.entries.map((e) => (
                  <tr
                    key={`${e.caseId}-${e.harness}-${e.runtime ?? ''}`}
                    className="border-b last:border-0"
                  >
                    <td className="px-3 py-2 font-mono text-[12px]">{e.caseId}</td>
                    <td className="px-3 py-2 font-mono text-[12px]">{e.harness}</td>
                    <td className="px-3 py-2 text-muted-foreground">{e.runtime ?? '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {t('flake.passFail', { passes: e.passes, failures: e.failures })}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {fmtPct(e.flakeScore)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </section>
  )
}
