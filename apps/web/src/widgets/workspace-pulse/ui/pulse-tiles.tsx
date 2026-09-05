import { getTranslations } from 'next-intl/server'

import type { WorkspacePulse } from '@/entities/workspace-pulse'
import { fmtPct } from '@/shared/lib/format'
import { Link } from '@/shared/ui/link'
import { StatCard } from '@/shared/ui/stat-card'

// State — what condition this workspace is in right now. The eight numbers each stand for one axis of the product: work (issues, regressions),
// iterations, goals, agents, executions, quality, and the total volume of recorded activity.
//
// Every tile is a LINK. What you do after seeing a number on a dashboard is always "so what IS that", and with no route to the screen holding
// the answer, a number becomes decoration you read and forget.

// A change in pass rate is read in PERCENTAGE POINTS — going from 74% to 78% is +4pt, not +5.4%. With both values on screen together, points
// are the side the reader can check for themselves (the same judgement as analysis-artifact's metricDelta).
function passRatePoints(now: number, before: number): number {
  return Math.round((now - before) * 1000) / 10
}

function Tile({
  href,
  label,
  value,
  hint,
  tone,
}: {
  // It can be absent — a number whose answer IS this screen (recorded activity) has the feed below as that answer, so attaching a link would
  // make a link that takes you nowhere.
  href?: string
  label: string
  value: string | number
  hint?: string
  tone?: 'default' | 'primary' | 'success' | 'danger'
}) {
  const card = (
    <StatCard
      label={label}
      value={value}
      {...(hint !== undefined ? { hint } : {})}
      {...(tone ? { tone } : {})}
    />
  )
  if (href === undefined) return card
  return (
    <Link href={href} className="block">
      {card}
    </Link>
  )
}

export async function PulseTiles({
  pulse,
  workspace,
}: {
  pulse: WorkspacePulse
  workspace: string
}) {
  const t = await getTranslations('overviewPage')
  const base = `/${workspace}`
  const { work, goals, agents, evaluation, trend } = pulse

  // A cycle's progress is the completion ratio over ALL the work the active cycles committed. With nothing committed there is no ratio —
  // drawn as 0% it reads as "nothing got done", when what it means is "nothing has been put in yet".
  const activityTotal = trend.activity.reduce((sum, point) => sum + point.total, 0)
  const perDay = trend.activity.length > 0 ? Math.round(activityTotal / trend.activity.length) : 0
  const delta =
    evaluation.passRate !== undefined && evaluation.passRateBefore !== undefined
      ? passRatePoints(evaluation.passRate, evaluation.passRateBefore)
      : undefined

  return (
    <div className="grid grid-cols-2 gap-3 @2xl:grid-cols-4">
      <Tile
        href={`${base}/issues`}
        label={t('tileOpenIssues')}
        value={work.open}
        hint={t('tileOpenIssuesHint', { count: work.inProgress })}
      />
      <Tile
        href={`${base}/issues?status=regressed`}
        label={t('tileRegressed')}
        value={work.regressed}
        {...(work.regressed > 0
          ? { tone: 'danger' as const, hint: t('tileRegressedHint') }
          : { hint: t('tileRegressedNone') })}
      />
      <Tile
        href={`${base}/initiatives`}
        label={t('tileGoals')}
        value={goals.initiatives}
        hint={t('tileGoalsHint', { projects: goals.projects, atRisk: goals.atRisk })}
      />
      <Tile
        href={`${base}/agents`}
        label={t('tileAgents')}
        value={agents.runs}
        hint={t('tileAgentsHint', { tasks: agents.openTasks, approvals: agents.awaitingApproval })}
      />
      <Tile
        href={`${base}/runs`}
        label={t('tileRuns')}
        value={evaluation.runs}
        // The run COUNT is not painted red even when there are failures — what is alarming is the failures, not the volume, and a big number
        // turning red makes a day of heavy running read as a bad day. The failures are stated by the hint.
        hint={t('tileRunsHint', { failed: evaluation.failed })}
      />
      <Tile
        href={`${base}/scorecards`}
        label={t('tilePassRate')}
        value={evaluation.passRate !== undefined ? fmtPct(evaluation.passRate) : '–'}
        hint={
          delta === undefined
            ? t('tilePassRateHint', { count: evaluation.scorecards })
            : t('tilePassRateDelta', {
                sign: delta > 0 ? '+' : '',
                points: delta,
                count: evaluation.scorecards,
              })
        }
        {...(delta !== undefined && delta !== 0
          ? { tone: delta > 0 ? ('success' as const) : ('danger' as const) }
          : {})}
      />
      <Tile
        label={t('tileActivity')}
        value={activityTotal}
        hint={t('tileActivityHint', { perDay })}
      />
    </div>
  )
}
