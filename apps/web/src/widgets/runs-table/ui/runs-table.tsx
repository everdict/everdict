import Link from 'next/link'

import type { Run } from '@/entities/run'
import { EmptyState } from '@/shared/ui/empty-state'
import { StatusPill } from '@/shared/ui/status-pill'

function scoreSummary(run: Run): string {
  const scores = run.result?.scores ?? []
  if (scores.length === 0) return '—'
  return scores.map((s) => `${s.graderId}:${s.value}`).join('  ')
}

export function RunsTable({ runs, limit }: { runs: Run[]; limit?: number }) {
  const rows = limit ? runs.slice(0, limit) : runs
  if (rows.length === 0) {
    return (
      <EmptyState
        title="아직 실행한 run 이 없습니다."
        hint="하니스를 골라 평가를 제출하면 여기에 표시됩니다."
      />
    )
  }
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <table className="w-full text-sm">
        <thead className="border-b border-border/70 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-4 py-2.5 font-medium">run</th>
            <th className="px-4 py-2.5 font-medium">harness</th>
            <th className="px-4 py-2.5 font-medium">status</th>
            <th className="px-4 py-2.5 font-medium">scores</th>
            <th className="px-4 py-2.5 font-medium">updated</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((run) => (
            <tr
              key={run.id}
              className="border-b border-border/50 transition-colors last:border-0 hover:bg-muted/50"
            >
              <td className="px-4 py-2.5">
                <Link
                  href={`/dashboard/runs/${run.id}`}
                  className="font-mono text-xs text-primary transition-opacity hover:opacity-80"
                >
                  {run.id.slice(0, 8)}
                </Link>
              </td>
              <td className="px-4 py-2.5">
                {run.harness.id}
                <span className="text-muted-foreground">@{run.harness.version}</span>
              </td>
              <td className="px-4 py-2.5">
                <StatusPill status={run.status} />
              </td>
              <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">
                {scoreSummary(run)}
              </td>
              <td className="px-4 py-2.5 text-xs text-muted-foreground">
                {new Date(run.updatedAt).toLocaleString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
