'use client'

import { useLocale, useTimeZone, useTranslations } from 'next-intl'

import { fmtTimeAgo, fmtTokens, fmtUsd } from '@/shared/lib/format'
import { Badge } from '@/shared/ui/badge'
import { Link } from '@/shared/ui/link'
import { StatusPill } from '@/shared/ui/status-pill'
import { TD, TR } from '@/shared/ui/table'

import type { Run, Usage } from '../model/schema'

type Translate = ReturnType<typeof useTranslations<'runsTable'>>

// Source (the activity view's source axis) — a human-readable label. Unset = direct API.
const SOURCE_KEY: Record<string, string> = {
  web: 'sourceWeb',
  mcp: 'sourceMcp',
  api: 'sourceApi',
  scorecard: 'sourceScorecard',
  schedule: 'sourceSchedule',
  'front-door': 'sourceFrontDoor',
}
export function sourceLabel(t: Translate, trigger?: string): string {
  if (!trigger) return t('sourceDirect')
  const key = SOURCE_KEY[trigger]
  return key ? t(key) : trigger
}

// Cost/token summary — usage derived from the trace. undefined (→ "—") when not yet run / no trace.
export function costLabel(usage?: Usage): string | undefined {
  if (!usage || (usage.usd === 0 && usage.totalTokens === 0)) return undefined
  return `${fmtUsd(usage.usd)} · ${fmtTokens(usage.totalTokens)} tok`
}

// The minimal run fields a row needs — the activity console strips full run records to this before sending to the client.
export type RunRowData = Pick<
  Run,
  'id' | 'harness' | 'caseId' | 'status' | 'kind' | 'trigger' | 'usage' | 'updatedAt'
>

// One run row (self-contained: pulls its own i18n/locale). isChild = a scorecard case row (indented under its batch
// header, caseId in place of the source badge). Shared by the dashboard runs-table and the activity console.
// childKind: 같은 들여쓰기 자식이라도 컬럼의 의미가 다르다 — 스코어카드 자식의 caseId 는 케이스지만, 대화 턴의
// caseId 는 깨어난 원인(chat / 이벤트 kind)이라 "케이스 chat" 으로 읽히면 거짓말이 된다(run 상세와 같은 규칙).
export function RunRow({
  run,
  workspace,
  isChild,
  childKind = 'case',
}: {
  run: RunRowData
  workspace: string
  isChild?: boolean
  childKind?: 'case' | 'turn'
}) {
  const t = useTranslations('runsTable')
  const locale = useLocale()
  const timeZone = useTimeZone()
  const c = costLabel(run.usage)
  return (
    <TR className="group">
      <TD className={isChild ? 'pl-7' : undefined}>
        <Link
          href={`/${workspace}/run/${run.id}`}
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
        {isChild ? (
          <span className="font-mono text-[12px] text-muted-foreground">
            {childKind === 'turn' ? t('turnCell', { cause: run.caseId }) : t('caseCell', { id: run.caseId })}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5">
            {/* Executable family (universal-run P0) — badge only the non-eval kinds; eval rows stay as before. */}
            {run.kind && run.kind !== 'eval' && <Badge tone="info">{run.kind}</Badge>}
            <Badge tone="outline">{sourceLabel(t, run.trigger)}</Badge>
          </span>
        )}
      </TD>
      <TD>
        <StatusPill status={run.status} />
      </TD>
      <TD className="whitespace-nowrap text-right font-mono text-[12px] text-muted-foreground">
        {c ?? <span className="text-faint">—</span>}
      </TD>
      <TD className="whitespace-nowrap text-right text-[12px] text-muted-foreground">
        {fmtTimeAgo(run.updatedAt, locale, timeZone)}
      </TD>
    </TR>
  )
}
