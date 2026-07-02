import Link from 'next/link'

import type { Run, Usage } from '@/entities/run'
import type { ScorecardRecord } from '@/entities/scorecard'
import { Badge } from '@/shared/ui/badge'
import { EmptyState } from '@/shared/ui/empty-state'
import { StatusPill } from '@/shared/ui/status-pill'
import { Table, TBody, TD, TH, THead, TR } from '@/shared/ui/table'

// standalone run + 스코어카드 배치를 한 타임라인으로 합친 통합 활동 피드.
// run 은 개별 실행(출처/비용), 스코어카드는 배치 평가(통과율) — 각자 상세로 링크. /scorecards 목록은 그대로 유지(중복 아님, 다른 관점).
type Item =
  | { kind: 'run'; id: string; updatedAt: string; run: Run }
  | { kind: 'scorecard'; id: string; updatedAt: string; sc: ScorecardRecord }

const SOURCE_LABEL: Record<string, string> = {
  web: '웹',
  mcp: '에이전트',
  api: 'API',
  scorecard: '스코어카드',
  schedule: '예약',
  'front-door': 'front-door',
}
function sourceLabel(trigger?: string): string {
  return trigger ? (SOURCE_LABEL[trigger] ?? trigger) : '직접'
}

function cost(usage?: Usage): string | undefined {
  if (!usage || (usage.usd === 0 && usage.totalTokens === 0)) return undefined
  const tok =
    usage.totalTokens >= 1000 ? `${(usage.totalTokens / 1000).toFixed(1)}k` : `${usage.totalTokens}`
  return `$${usage.usd.toFixed(2)} · ${tok} tok`
}

// 스코어카드 요약 한 줄 — passRate 가 있는 메트릭이면 통과율, 아니면 메트릭 수.
function scorecardSummary(sc: ScorecardRecord): string {
  const withRate = (sc.summary ?? []).find((m) => m.passRate != null)
  if (withRate?.passRate != null) return `${Math.round(withRate.passRate * 100)}% 통과`
  const n = sc.summary?.length ?? 0
  return n > 0 ? `${n}개 메트릭` : '—'
}

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

export function ActivityFeed({
  runs,
  scorecards,
  workspace,
}: {
  runs: Run[]
  scorecards: ScorecardRecord[]
  workspace: string
}) {
  const items: Item[] = [
    ...runs.map((run): Item => ({ kind: 'run', id: run.id, updatedAt: run.updatedAt, run })),
    ...scorecards.map(
      (sc): Item => ({ kind: 'scorecard', id: sc.id, updatedAt: sc.updatedAt, sc })
    ),
  ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

  if (items.length === 0) {
    return (
      <EmptyState
        title="아직 활동이 없습니다."
        hint="run 을 제출하거나 스코어카드를 실행하면 여기에 타임라인으로 표시됩니다."
      />
    )
  }
  return (
    <Table>
      <THead>
        <tr>
          <TH className="w-[110px]">종류</TH>
          <TH>대상</TH>
          <TH>상태</TH>
          <TH className="text-right">요약</TH>
          <TH className="text-right">업데이트</TH>
        </tr>
      </THead>
      <TBody>
        {items.map((it) =>
          it.kind === 'run' ? (
            <TR key={`run-${it.id}`} className="group">
              <TD>
                <Badge tone="outline">run</Badge>
              </TD>
              <TD>
                <Link
                  href={`/${workspace}/runs/${it.id}`}
                  className="text-link transition-colors hover:text-foreground"
                >
                  <span className="font-[510]">{it.run.harness.id}</span>
                  <span className="text-muted-foreground">@{it.run.harness.version}</span>
                </Link>
                <span className="ml-2 text-[11px] text-faint">{sourceLabel(it.run.trigger)}</span>
              </TD>
              <TD>
                <StatusPill status={it.run.status} />
              </TD>
              <TD className="whitespace-nowrap text-right font-mono text-[12px] text-muted-foreground">
                {cost(it.run.usage) ?? <span className="text-faint">—</span>}
              </TD>
              <TD className="whitespace-nowrap text-right text-[12px] text-muted-foreground">
                {ago(it.updatedAt)}
              </TD>
            </TR>
          ) : (
            <TR key={`sc-${it.id}`} className="group">
              <TD>
                <Badge tone="info">스코어카드</Badge>
              </TD>
              <TD>
                <Link
                  href={`/${workspace}/scorecards/${it.id}`}
                  className="text-link transition-colors hover:text-foreground"
                >
                  <span className="font-[510]">{it.sc.dataset.id}</span>
                  <span className="text-muted-foreground">
                    @{it.sc.dataset.version} → {it.sc.harness.id}@{it.sc.harness.version}
                  </span>
                </Link>
              </TD>
              <TD>
                <StatusPill status={it.sc.status} />
              </TD>
              <TD className="whitespace-nowrap text-right font-mono text-[12px] text-muted-foreground">
                {scorecardSummary(it.sc)}
              </TD>
              <TD className="whitespace-nowrap text-right text-[12px] text-muted-foreground">
                {ago(it.updatedAt)}
              </TD>
            </TR>
          )
        )}
      </TBody>
    </Table>
  )
}
