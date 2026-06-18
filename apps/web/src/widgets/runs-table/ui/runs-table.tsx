import { type Run } from '@/entities/run'
import { Badge } from '@/shared/ui/badge'
import { Card } from '@/shared/ui/card'

const STATUS_TONE = {
  succeeded: 'success',
  failed: 'danger',
  running: 'info',
  queued: 'neutral',
} as const

function scoreSummary(run: Run): string {
  const scores = run.result?.scores ?? []
  if (scores.length === 0) return '—'
  return scores.map((s) => `${s.graderId}:${s.value}`).join('  ')
}

export function RunsTable({ runs }: { runs: Run[] }) {
  if (runs.length === 0) {
    return (
      <Card className="p-8 text-center text-sm text-muted-foreground">아직 실행한 run 이 없습니다.</Card>
    )
  }
  return (
    <Card className="overflow-hidden">
      <table className="w-full text-sm">
        <thead className="border-b bg-secondary/50 text-left text-muted-foreground">
          <tr>
            <th className="px-4 py-3 font-medium">run</th>
            <th className="px-4 py-3 font-medium">harness</th>
            <th className="px-4 py-3 font-medium">status</th>
            <th className="px-4 py-3 font-medium">scores</th>
            <th className="px-4 py-3 font-medium">updated</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id} className="border-b last:border-0">
              <td className="px-4 py-3 font-mono text-xs">{run.id.slice(0, 8)}</td>
              <td className="px-4 py-3">
                {run.harness.id}
                <span className="text-muted-foreground">@{run.harness.version}</span>
              </td>
              <td className="px-4 py-3">
                <Badge tone={STATUS_TONE[run.status]}>{run.status}</Badge>
              </td>
              <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{scoreSummary(run)}</td>
              <td className="px-4 py-3 text-xs text-muted-foreground">
                {new Date(run.updatedAt).toLocaleString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  )
}
