import Link from 'next/link'

import type { Run, Usage } from '@/entities/run'
import { Badge } from '@/shared/ui/badge'
import { EmptyState } from '@/shared/ui/empty-state'
import { StatusPill } from '@/shared/ui/status-pill'
import { Table, TBody, TD, TH, THead, TR } from '@/shared/ui/table'

// 출처(활동 뷰 source 축) — 사람이 읽는 라벨. 미설정=직접 API.
const SOURCE_LABEL: Record<string, string> = {
  web: '웹',
  mcp: '에이전트',
  api: 'API',
  scorecard: '스코어카드',
  schedule: '예약',
  'front-door': 'front-door',
}
function sourceLabel(trigger?: string): string {
  if (!trigger) return '직접'
  return SOURCE_LABEL[trigger] ?? trigger
}

// 비용/토큰 요약 — 트레이스에서 파생된 usage. 없으면 —(아직 실행 전/트레이스 없음).
function cost(usage?: Usage): string | undefined {
  if (!usage || (usage.usd === 0 && usage.totalTokens === 0)) return undefined
  const tok =
    usage.totalTokens >= 1000 ? `${(usage.totalTokens / 1000).toFixed(1)}k` : `${usage.totalTokens}`
  return `$${usage.usd.toFixed(2)} · ${tok} tok`
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

// 활동 리스트: 이 워크스페이스에서 실행 중/실행된 standalone run(스코어카드 자식은 컨트롤플레인이 기본 제외).
// 평가 결과판이 아니라 "무엇이 · 어디서 · 얼마로 · 지금 어떤 상태로 돌고 있나"를 보이는 운영 콘솔.
export function RunsTable({
  runs,
  workspace,
  limit,
}: {
  runs: Run[]
  workspace: string
  limit?: number
}) {
  const rows = limit ? runs.slice(0, limit) : runs
  if (rows.length === 0) {
    return (
      <EmptyState
        title="아직 실행한 내역이 없어요."
        hint="하니스를 골라 실행하면 여기에 표시돼요."
      />
    )
  }
  return (
    <Table>
      <THead>
        <tr>
          <TH className="w-[120px]">실행</TH>
          <TH>하니스</TH>
          <TH>출처</TH>
          <TH>상태</TH>
          <TH className="text-right">비용</TH>
          <TH className="text-right">업데이트</TH>
        </tr>
      </THead>
      <TBody>
        {rows.map((run) => {
          const c = cost(run.usage)
          return (
            <TR key={run.id} className="group">
              <TD>
                <Link
                  href={`/${workspace}/runs/${run.id}`}
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
                <Badge tone="outline">{sourceLabel(run.trigger)}</Badge>
              </TD>
              <TD>
                <StatusPill status={run.status} />
              </TD>
              <TD className="whitespace-nowrap text-right font-mono text-[12px] text-muted-foreground">
                {c ?? <span className="text-faint">—</span>}
              </TD>
              <TD className="whitespace-nowrap text-right text-[12px] text-muted-foreground">
                {ago(run.updatedAt)}
              </TD>
            </TR>
          )
        })}
      </TBody>
    </Table>
  )
}
