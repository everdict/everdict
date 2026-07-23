import { Fragment } from 'react'
import Link from 'next/link'
import { Layers } from 'lucide-react'
import { useLocale, useTimeZone, useTranslations } from 'next-intl'

import { RunRow, type Run, type RunStatus } from '@/entities/run'
import { fmtTimeAgo } from '@/shared/lib/format'
import { Badge } from '@/shared/ui/badge'
import { EmptyState } from '@/shared/ui/empty-state'
import { StatusPill } from '@/shared/ui/status-pill'
import { Table, TBody, TH, THead, TR } from '@/shared/ui/table'

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
  const timeZone = useTimeZone()
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
            <RunRow key={block.run.id} run={block.run} workspace={workspace} isChild={false} />
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
                      {fmtTimeAgo(new Date(block.ts).toISOString(), locale, timeZone)}
                    </span>
                  </div>
                </td>
              </TR>
              {block.runs.map((run) => (
                <RunRow key={run.id} run={run} workspace={workspace} isChild />
              ))}
            </Fragment>
          )
        )}
      </TBody>
    </Table>
  )
}
