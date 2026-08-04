'use client'

import { useTranslations } from 'next-intl'

import { LineChart, seriesColorAt } from '@/shared/ui/charts'

import { cycleLengthDays } from '../lib/cycle-view'
import type { Cycle, CycleBurndown } from '../model/schema'

// 사이클 번다운 — 남은 포인트가 창의 끝에서 0 에 닿는가. 실선 둘은 서버가 이슈 이력에서 되감아 준 것이고
// (스코프 = 그날까지 이 주기에 들어온 일, 남은 = 그중 아직 안 끝난 일), 점선은 첫날 스코프에서 0 까지 곧게
// 내려가는 이상선이다(계산이 아니라 눈금 역할이라 여기서 그린다).
//
// 스코프 선이 따로 있는 것이 요점이다: 주기 중간에 일이 들어오면 그 선이 올라가므로, "계획보다 못 했다"와
// "일이 더 들어왔다"가 화면에서 구분된다. 이상선을 **첫날** 스코프에 묶는 것도 같은 이유 — 나중에 늘어난
// 몫까지 이상선이 따라 올라가면 무엇을 약속했는지가 사라진다.
//
// 지나지 않은 날은 값이 없다 — LineChart 의 null 이 선을 끊어 주므로, 오지 않은 날까지 평평하게 이어
// "아무것도 안 했다"로 보이는 일이 없다.
export function CycleBurndownChart({ cycle, burndown }: { cycle: Cycle; burndown: CycleBurndown }) {
  const t = useTranslations('cyclesPage')
  const days = cycleLengthDays(cycle)
  // 창 전체를 x 축으로 잡는다 — 실제 곡선이 절반에서 끊겨 있어야 "아직 절반 남았다"가 보인다.
  const dates = Array.from({ length: days }, (_, i) => {
    const at = new Date(`${cycle.startsAt}T00:00:00.000Z`)
    at.setUTCDate(at.getUTCDate() + i)
    return at.toISOString().slice(0, 10)
  })
  const measured = new Map(burndown.map((point) => [point.date, point]))
  const actual = dates.map((date) => measured.get(date)?.remaining ?? null)
  const scopeLine = dates.map((date) => measured.get(date)?.scope ?? null)
  // 이상선은 첫날 스코프에서 마지막 날 0 까지. 하루짜리 사이클이면 나눌 것이 없으니 0 하나로 끝난다.
  const committed = burndown[0]?.scope ?? 0
  const ideal = dates.map((_, i) => (days <= 1 ? 0 : Math.max(0, committed - (committed * i) / (days - 1))))

  return (
    <div className="space-y-2">
      <LineChart
        x={dates}
        series={[
          { key: 'actual', label: t('burndownActual'), color: seriesColorAt(0) },
          { key: 'scope', label: t('burndownScope'), color: seriesColorAt(1) },
          { key: 'ideal', label: t('burndownIdeal'), color: seriesColorAt(4) },
        ]}
        values={[actual, scopeLine, ideal]}
        formatValue={(v) => `${Math.round(v)}`}
        // 날짜 축은 월/일이면 충분하다 — 창 안에서 연도가 바뀌어도 두 자리로 읽힌다.
        formatX={(label) => label.slice(5)}
        ariaLabel={t('burndownAria')}
        emptyLabel={t('burndownEmpty')}
      />
      {/* 남은 한 가지 한계는 역사적인 것뿐이다: 사이클 이동을 기록하기 전에 옮겨진 이슈는 그 기록이 없어
          창 전체에 걸쳐 세어진다. 조용히 두면 "처음부터 그만큼이었다"로 읽히므로 화면이 적는다. */}
      <p className="text-[11.5px] leading-relaxed text-faint">{t('burndownCaveat')}</p>
    </div>
  )
}
