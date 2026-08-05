import { getTranslations } from 'next-intl/server'

import type { WorkspacePulse } from '@/entities/workspace-pulse'
import { fmtPct } from '@/shared/lib/format'
import { Link } from '@/shared/ui/link'
import { StatCard } from '@/shared/ui/stat-card'

// 현황 — 지금 이 워크스페이스가 어떤 상태인가. 여덟 개의 숫자는 제품의 축을 하나씩 대표한다: 일(이슈·회귀),
// 이터레이션, 목표, 에이전트, 실행, 품질, 그리고 기록된 활동의 총량.
//
// 타일은 전부 링크다. 대시보드에서 숫자를 본 다음에 하는 일은 언제나 "그래서 그게 뭔데"이고, 그 답이 있는
// 화면으로 가는 길이 없으면 숫자는 읽고 끝나는 장식이 된다.

// 통과율의 변화는 퍼센트 포인트로 읽는다 — 74%에서 78%로 간 것은 +4pt 이지 +5.4% 가 아니다. 두 값이 화면에
// 같이 있을 때 독자가 직접 검산할 수 있는 쪽이 포인트다(analysis-artifact 의 metricDelta 와 같은 판단).
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
  // 없을 수도 있다 — 이 화면 자체가 답인 숫자(기록된 활동)는 아래 피드가 그 답이라, 링크를 달면 어디로도
  // 데려가지 못하는 링크가 된다.
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
  const { work, cycles, goals, agents, evaluation, trend } = pulse

  // 사이클의 진행률은 활성 사이클들이 커밋한 일 전체에 대한 완료 비율이다. 커밋한 것이 없으면 비율도 없다 —
  // 0% 로 그리면 "아무것도 못 했다"로 읽히는데, 사실은 "아직 아무것도 담지 않았다"이다.
  const cycleProgress = cycles.committed > 0 ? fmtPct(cycles.done / cycles.committed) : '–'
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
        href={`${base}/cycles`}
        label={t('tileCycle')}
        value={cycleProgress}
        hint={
          cycles.active === 0
            ? t('tileCycleNone')
            : t('tileCycleHint', {
                active: cycles.active,
                done: cycles.done,
                committed: cycles.committed,
              })
        }
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
        // 실패가 있어도 실행 '수'는 빨갛게 칠하지 않는다 — 경보인 것은 실패지 실행량이 아니고, 큰 숫자가
        // 빨개지면 많이 돌린 날이 나쁜 날처럼 읽힌다. 실패는 힌트가 말한다.
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
