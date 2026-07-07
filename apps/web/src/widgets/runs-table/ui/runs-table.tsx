import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'

import type { Run, Usage } from '@/entities/run'
import { Badge } from '@/shared/ui/badge'
import { EmptyState } from '@/shared/ui/empty-state'
import { StatusPill } from '@/shared/ui/status-pill'
import { Table, TBody, TD, TH, THead, TR } from '@/shared/ui/table'

type Translate = ReturnType<typeof useTranslations<'runsTable'>>

// 출처(활동 뷰 source 축) — 사람이 읽는 라벨. 미설정=직접 API.
const SOURCE_KEY: Record<string, string> = {
  web: 'sourceWeb',
  mcp: 'sourceMcp',
  api: 'sourceApi',
  scorecard: 'sourceScorecard',
  schedule: 'sourceSchedule',
  'front-door': 'sourceFrontDoor',
}
function sourceLabel(t: Translate, trigger?: string): string {
  if (!trigger) return t('sourceDirect')
  const key = SOURCE_KEY[trigger]
  return key ? t(key) : trigger
}

// 비용/토큰 요약 — 트레이스에서 파생된 usage. 없으면 —(아직 실행 전/트레이스 없음).
function cost(usage?: Usage): string | undefined {
  if (!usage || (usage.usd === 0 && usage.totalTokens === 0)) return undefined
  const tok =
    usage.totalTokens >= 1000 ? `${(usage.totalTokens / 1000).toFixed(1)}k` : `${usage.totalTokens}`
  return `$${usage.usd.toFixed(2)} · ${tok} tok`
}

// 상대 시간 — Linear 식 간결 표기.
function ago(t: Translate, locale: string, iso: string): string {
  const d = new Date(iso).getTime()
  const diff = Date.now() - d
  const m = Math.round(diff / 60000)
  if (m < 1) return t('justNow')
  if (m < 60) return t('minutesAgo', { m })
  const h = Math.round(m / 60)
  if (h < 24) return t('hoursAgo', { h })
  const days = Math.round(h / 24)
  if (days < 30) return t('daysAgo', { days })
  return new Date(iso).toLocaleDateString(locale, { month: 'short', day: 'numeric' })
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
  const t = useTranslations('runsTable')
  const locale = useLocale()
  const rows = limit ? runs.slice(0, limit) : runs
  if (rows.length === 0) {
    return <EmptyState title={t('emptyTitle')} hint={t('emptyHint')} />
  }
  return (
    <Table>
      <THead>
        <tr>
          <TH className="w-[120px]">{t('colRun')}</TH>
          <TH>{t('colHarness')}</TH>
          <TH>{t('colSource')}</TH>
          <TH>{t('colStatus')}</TH>
          <TH className="text-right">{t('colCost')}</TH>
          <TH className="text-right">{t('colUpdated')}</TH>
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
                <Badge tone="outline">{sourceLabel(t, run.trigger)}</Badge>
              </TD>
              <TD>
                <StatusPill status={run.status} />
              </TD>
              <TD className="whitespace-nowrap text-right font-mono text-[12px] text-muted-foreground">
                {c ?? <span className="text-faint">—</span>}
              </TD>
              <TD className="whitespace-nowrap text-right text-[12px] text-muted-foreground">
                {ago(t, locale, run.updatedAt)}
              </TD>
            </TR>
          )
        })}
      </TBody>
    </Table>
  )
}
