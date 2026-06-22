import Link from 'next/link'

import type { Run } from '@/entities/run'
import { EmptyState } from '@/shared/ui/empty-state'
import { StatusPill } from '@/shared/ui/status-pill'
import { Table, TBody, TD, TH, THead, TR } from '@/shared/ui/table'

function scores(run: Run): { graderId: string; value: number | string }[] {
  return run.result?.scores ?? []
}

// 상대 시간(ko) — Linear 식 간결 표기.
function ago(iso: string): string {
  const d = new Date(iso).getTime()
  const diff = Date.now() - d
  const m = Math.round(diff / 60000)
  if (m < 1) return '방금'
  if (m < 60) return `${m}분 전`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}시간 전`
  const days = Math.round(h / 24)
  if (days < 30) return `${days}일 전`
  return new Date(iso).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' })
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
    <Table>
      <THead>
        <tr>
          <TH className="w-[120px]">Run</TH>
          <TH>하니스</TH>
          <TH>상태</TH>
          <TH>점수</TH>
          <TH className="text-right">업데이트</TH>
        </tr>
      </THead>
      <TBody>
        {rows.map((run) => (
          <TR key={run.id} className="group">
            <TD>
              <Link
                href={`/dashboard/runs/${run.id}`}
                className="font-mono text-[12px] text-link transition-colors hover:text-foreground"
              >
                {run.id.slice(0, 8)}
              </Link>
            </TD>
            <TD>
              <span className="font-[510]">{run.harness.id}</span>
              <span className="text-muted-foreground">@{run.harness.version}</span>
            </TD>
            <TD>
              <StatusPill status={run.status} />
            </TD>
            <TD className="font-mono text-[12px] text-muted-foreground">
              {scores(run).length === 0 ? (
                <span className="text-faint">—</span>
              ) : (
                <span className="inline-flex flex-wrap gap-x-2.5 gap-y-0.5">
                  {scores(run).map((s) => (
                    <span key={s.graderId}>
                      <span className="text-faint">{s.graderId}</span> {s.value}
                    </span>
                  ))}
                </span>
              )}
            </TD>
            <TD className="whitespace-nowrap text-right text-[12px] text-muted-foreground">
              {ago(run.updatedAt)}
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  )
}
