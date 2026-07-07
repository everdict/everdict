import { useTranslations } from 'next-intl'

import type { Run } from '@/entities/run'
import { StatCard } from '@/shared/ui/stat-card'

// Tenant score summary cards. The heart of the per-tenant dashboard.
export function ScorecardSummary({ runs }: { runs: Run[] }) {
  const t = useTranslations('scorecardSummary')
  const total = runs.length
  const succeeded = runs.filter((r) => r.status === 'succeeded').length
  const failed = runs.filter((r) => r.status === 'failed').length
  const inflight = runs.filter((r) => r.status === 'queued' || r.status === 'running').length
  const passRate = total ? Math.round((succeeded / total) * 100) : 0

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <StatCard label={t('statTotal')} value={total} />
      <StatCard label={t('statSucceeded')} value={succeeded} tone="success" />
      <StatCard label={t('statFailed')} value={failed} tone={failed > 0 ? 'danger' : 'default'} />
      <StatCard
        label={t('statSuccessRate')}
        value={`${passRate}%`}
        tone="primary"
        hint={t('inflight', { n: inflight })}
      />
    </div>
  )
}
