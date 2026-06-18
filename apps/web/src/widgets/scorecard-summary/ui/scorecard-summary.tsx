import type { Run } from '@/entities/run'
import { StatCard } from '@/shared/ui/stat-card'

// 테넌트 스코어 요약 카드들. per-tenant 대시보드의 핵심.
export function ScorecardSummary({ runs }: { runs: Run[] }) {
  const total = runs.length
  const succeeded = runs.filter((r) => r.status === 'succeeded').length
  const failed = runs.filter((r) => r.status === 'failed').length
  const inflight = runs.filter((r) => r.status === 'queued' || r.status === 'running').length
  const passRate = total ? Math.round((succeeded / total) * 100) : 0

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <StatCard label="전체 run" value={total} />
      <StatCard label="성공" value={succeeded} tone="success" />
      <StatCard label="실패" value={failed} tone={failed > 0 ? 'danger' : 'default'} />
      <StatCard label="성공률" value={`${passRate}%`} tone="primary" hint={`진행중 ${inflight}`} />
    </div>
  )
}
