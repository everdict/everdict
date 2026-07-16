import { Fragment } from 'react'
import Link from 'next/link'
import { Layers } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'

import type { Run, RunStatus, Usage } from '@/entities/run'
import { Badge } from '@/shared/ui/badge'
import { EmptyState } from '@/shared/ui/empty-state'
import { StatusPill } from '@/shared/ui/status-pill'
import { Table, TBody, TD, TH, THead, TR } from '@/shared/ui/table'

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
function sourceLabel(t: Translate, trigger?: string): string {
  if (!trigger) return t('sourceDirect')
  const key = SOURCE_KEY[trigger]
  return key ? t(key) : trigger
}

// Cost/token summary — usage derived from the trace. If absent, — (not yet run / no trace).
function cost(usage?: Usage): string | undefined {
  if (!usage || (usage.usd === 0 && usage.totalTokens === 0)) return undefined
  const tok =
    usage.totalTokens >= 1000 ? `${(usage.totalTokens / 1000).toFixed(1)}k` : `${usage.totalTokens}`
  return `$${usage.usd.toFixed(2)} · ${tok} tok`
}

// Relative time — Linear-style concise rendering.
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

// A scorecard batch's rollup status from its children — still active if any child is; else failed if any failed.
function rollupStatus(runs: Run[]): RunStatus {
  if (runs.some((r) => r.status === 'running' || r.status === 'queued')) return 'running'
  if (runs.some((r) => r.status === 'failed')) return 'failed'
  return 'succeeded'
}

// The activity feed is ordered by recency; a batch sorts by its most recently updated child.
function latest(runs: Run[]): number {
  return Math.max(...runs.map((r) => new Date(r.updatedAt).getTime()))
}

// A standalone run, or a scorecard batch grouping its child runs — both sorted into one recency-ordered feed.
type Block =
  | { kind: 'run'; run: Run; ts: number }
  | { kind: 'group'; scorecardId: string; runs: Run[]; ts: number }

// Partition runs into standalone rows + per-scorecard groups, then order the whole feed by recency.
function toBlocks(runs: Run[]): Block[] {
  const groups = new Map<string, Run[]>()
  const blocks: Block[] = []
  for (const run of runs) {
    if (run.parentScorecardId) {
      const arr = groups.get(run.parentScorecardId)
      if (arr) arr.push(run)
      else groups.set(run.parentScorecardId, [run])
    } else {
      blocks.push({ kind: 'run', run, ts: new Date(run.updatedAt).getTime() })
    }
  }
  for (const [scorecardId, gr] of groups) {
    blocks.push({ kind: 'group', scorecardId, runs: gr, ts: latest(gr) })
  }
  return blocks.sort((a, b) => b.ts - a.ts)
}

// One run row. isChild = a scorecard case row (indented under its batch header, caseId in place of the source badge).
function RunRow({
  run,
  workspace,
  t,
  locale,
  isChild,
}: {
  run: Run
  workspace: string
  t: Translate
  locale: string
  isChild?: boolean
}) {
  const c = cost(run.usage)
  return (
    <TR className="group">
      <TD className={isChild ? 'pl-7' : undefined}>
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
        {isChild ? (
          <span className="font-mono text-[12px] text-muted-foreground">
            {t('caseCell', { id: run.caseId })}
          </span>
        ) : (
          <Badge tone="outline">{sourceLabel(t, run.trigger)}</Badge>
        )}
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
}

// Activity list: every run running/run in this workspace. Standalone runs are individual rows; scorecard child runs
// are grouped under their batch (a header row + indented case rows) so a batch reads as one block, not a flood.
// Not an eval scoreboard but an operations console: "what · where · at what cost · in what state right now".
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
  const blocks = toBlocks(rows)
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
        {blocks.map((block) =>
          block.kind === 'run' ? (
            <RunRow
              key={block.run.id}
              run={block.run}
              workspace={workspace}
              t={t}
              locale={locale}
              isChild={false}
            />
          ) : (
            <Fragment key={block.scorecardId}>
              <TR className="bg-muted/40">
                <td colSpan={6} className="px-3 py-1.5">
                  <div className="flex items-center gap-2">
                    <Layers className="size-3.5 text-muted-foreground" />
                    <span className="text-[12px] font-[510] text-muted-foreground">
                      {t('batchGroup')}
                    </span>
                    <Link
                      href={`/${workspace}/scorecards/${block.scorecardId}`}
                      className="font-mono text-[12px] text-link transition-colors hover:text-foreground"
                    >
                      {block.scorecardId.slice(0, 8)}
                    </Link>
                    <Badge tone="outline">{t('batchCount', { n: block.runs.length })}</Badge>
                    <StatusPill status={rollupStatus(block.runs)} />
                    <span className="ml-auto text-[12px] text-muted-foreground">
                      {ago(t, locale, new Date(block.ts).toISOString())}
                    </span>
                  </div>
                </td>
              </TR>
              {block.runs.map((run) => (
                <RunRow
                  key={run.id}
                  run={run}
                  workspace={workspace}
                  t={t}
                  locale={locale}
                  isChild
                />
              ))}
            </Fragment>
          )
        )}
      </TBody>
    </Table>
  )
}
