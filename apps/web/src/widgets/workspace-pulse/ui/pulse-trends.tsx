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

// 추이 — 워크스페이스가 어느 쪽으로 움직이고 있나. 세 질문을 세 그림으로 나눈다:
//   ① 무엇이 벌어지고 있나(축별 활동량)  ② 일이 들어오는 속도와 나가는 속도  ③ 평가가 매기는 점수
// 팀별 비교를 그리지 않는 것은 의도다(사용자 결정): 대시보드가 팀을 나란히 세우는 순간 현황판이 아니라
// 성과표가 되고, 정작 "지금 어떤가/어디로 가는가"라는 질문은 화면에서 사라진다.

// 날짜 축은 M/D 로만 — 30개의 눈금에 연도를 붙이면 축이 글자로 덮인다. UTC 로 읽는 이유는 서버가 UTC 로
// 하루를 자르기 때문이다(로컬로 다시 해석하면 어떤 독자에게는 막대가 하루씩 밀린다).
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

  // 밴드의 이름은 그 밴드가 세는 것을 말해야 한다 — "작업"처럼 제품 어디에도 없는 낱말이면 독자는 무엇이
  // 거기 쌓였는지 알 길이 없다. 이름은 가장 큰 구성요소를 부르고(이슈·프로젝트), 정확한 내역은 hint 가
  // 진다: 축 하나가 스무 종류가 넘는 사실을 묶으므로 두 낱말로는 다 담기지 않는다(가이드 문구는 인라인이
  // 아니라 InfoTip 으로 — `.claude` 규약).
  // 이름·색·값이 한 자리에 있는 이유: 범례와 값이 따로 나열되면 한쪽만 순서가 바뀌어도 라벨이 남의 막대를
  // 가리키고, 그건 화면에 아무 티도 나지 않는다.
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

      {/* 한 행에 선 두 차트는 높이를 맞춘다 — 한쪽이 빈 상태(그 기간에 채점된 것이 없음)일 때 내용 높이에
          맡기면 그 칸만 짧아져 행이 어긋난다. 섹션을 flex 열로 두고 카드가 남은 높이를 먹는다. */}
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
            {/* 측정이 없던 날은 null 이다 — 선이 끊긴다. 0 으로 이으면 아무도 평가를 돌리지 않은 주말이
                품질이 무너진 것처럼 보인다. 축은 0~100% 로 고정한다(비율의 프레임은 언제나 전체다). */}
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
