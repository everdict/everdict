'use client'

import { useFormatter, useTranslations } from 'next-intl'

import type {
  PulseActivityPoint,
  PulseFlowPoint,
  PulseQualityPoint,
} from '@/entities/workspace-pulse'
import { fmtPct } from '@/shared/lib/format'
import { BarChart, LineChart, seriesColorAt } from '@/shared/ui/charts'
import { SectionHeader } from '@/shared/ui/section-header'
import { InfoTip } from '@/shared/ui/tooltip'

// Trends — which way the workspace is moving. Three questions as three pictures:
//   ① what is happening (activity per axis)  ② the rate work arrives and the rate it leaves  ③ the score evaluation gives
// Not drawing a per-team comparison is deliberate (a user decision): the moment a dashboard stands teams side by side it stops being a status
// board and becomes a scoreboard, and the actual question — how are we now, where are we going — disappears from the screen.

// The date axis is M/D only — putting a year on thirty ticks buries the axis in text. It is read in UTC because the server cuts a day in UTC
// (re-interpreted locally, some readers would see every bar shifted by a day).
function useDayLabel(): (date: string) => string {
  const format = useFormatter()
  return (date: string) =>
    format.dateTime(new Date(`${date}T00:00:00.000Z`), {
      month: 'numeric',
      day: 'numeric',
      timeZone: 'UTC',
    })
}

export function PulseTrends({
  activity,
  flow,
  quality,
}: {
  activity: PulseActivityPoint[]
  flow: PulseFlowPoint[]
  quality: PulseQualityPoint[]
}) {
  const t = useTranslations('overviewPage')
  const dayLabel = useDayLabel()
  const days = activity.map((point) => point.date)
  const count = (n: number) => String(Math.round(n))

  // A band's name has to say what that band COUNTS — a word that appears nowhere in the product leaves the reader no way to know what
  // accumulated there. The name calls the largest component (issues, projects) and the exact breakdown is carried by the hint: one axis
  // groups more than twenty kinds of fact, which two words cannot hold (guidance goes in an InfoTip rather than inline — the `.claude` convention).
  // rather than inline — the `.claude` convention).
  // Name, colour and value sit in one place because with the legend and the values listed separately, one of them changing order makes a label
  // at somebody else's bar, and that leaves no visible trace on screen.
  const bands = [
    {
      key: 'work',
      label: t('axisWork'),
      hint: t('axisWorkTip'),
      color: seriesColorAt(0),
      countOf: (point: PulseActivityPoint) => point.work,
    },
    {
      key: 'evaluation',
      label: t('axisEvaluation'),
      hint: t('axisEvaluationTip'),
      color: seriesColorAt(1),
      countOf: (point: PulseActivityPoint) => point.evaluation,
    },
    {
      key: 'agent',
      label: t('axisAgent'),
      hint: t('axisAgentTip'),
      color: seriesColorAt(2),
      countOf: (point: PulseActivityPoint) => point.agent,
    },
    {
      key: 'knowledge',
      label: t('axisKnowledge'),
      hint: t('axisKnowledgeTip'),
      color: seriesColorAt(3),
      countOf: (point: PulseActivityPoint) => point.knowledge,
    },
  ]

  return (
    <div className="space-y-5">
      <section className="space-y-2.5">
        <SectionHeader
          title={
            <span className="inline-flex items-center gap-1.5">
              {t('trendActivity')}
              <InfoTip
                content={
                  <span className="block space-y-1.5">
                    <span className="block text-muted-foreground">{t('trendActivityTip')}</span>
                    {bands.map((band) => (
                      <span key={band.key} className="flex items-start gap-1.5">
                        <span
                          className="mt-1 size-2.5 shrink-0 rounded-[3px]"
                          style={{ background: band.color }}
                        />
                        <span>
                          <span className="font-[560]">{band.label}</span>
                          <span className="text-muted-foreground"> — {band.hint}</span>
                        </span>
                      </span>
                    ))}
                  </span>
                }
              />
            </span>
          }
        />
        <div className="rounded-lg border bg-card p-3.5 shadow-raise">
          <BarChart
            x={days}
            stacked
            showTotal
            series={bands.map(({ key, label, color }) => ({ key, label, color }))}
            values={bands.map((band) => activity.map(band.countOf))}
            formatValue={count}
            formatX={dayLabel}
            ariaLabel={t('trendActivity')}
            emptyLabel={t('trendEmpty')}
          />
        </div>
      </section>

      {/* Two charts on one row are height-matched — left to their content height, the one that is EMPTY (nothing was scored in that period)
          becomes shorter and the row misaligns. The section is a flex column and the cards take the remaining height. */}
      <div className="grid grid-cols-1 items-stretch gap-5 @4xl:grid-cols-2">
        <section className="flex flex-col gap-2.5">
          <SectionHeader title={t('trendFlow')} />
          <div className="flex-1 rounded-lg border bg-card p-3.5 shadow-raise">
            <BarChart
              x={flow.map((point) => point.date)}
              series={[
                { key: 'created', label: t('flowCreated'), color: seriesColorAt(0) },
                { key: 'completed', label: t('flowCompleted'), color: seriesColorAt(2) },
              ]}
              values={[flow.map((p) => p.created), flow.map((p) => p.completed)]}
              formatValue={count}
              formatX={dayLabel}
              ariaLabel={t('trendFlow')}
              emptyLabel={t('trendEmpty')}
            />
          </div>
        </section>

        <section className="flex flex-col gap-2.5">
          <SectionHeader title={t('trendQuality')} />
          <div className="flex-1 rounded-lg border bg-card p-3.5 shadow-raise">
            {/* A day with no measurement is null — the line BREAKS. Joined through 0, a weekend when nobody ran an evaluation looks like
                quality collapsing. The axis is pinned to 0–100% (a ratio's frame is always the whole). */}
            <LineChart
              x={quality.map((point) => point.date)}
              series={[{ key: 'passRate', label: t('qualityPassRate'), color: seriesColorAt(1) }]}
              values={[quality.map((p) => p.passRate ?? null)]}
              domain={{ min: 0, max: 1 }}
              formatValue={fmtPct}
              formatX={dayLabel}
              ariaLabel={t('trendQuality')}
              emptyLabel={t('trendQualityEmpty')}
            />
          </div>
        </section>
      </div>
    </div>
  )
}
