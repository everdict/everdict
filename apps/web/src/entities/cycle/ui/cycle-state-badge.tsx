import { CalendarClock, CheckCircle2, Timer } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { Badge } from '@/shared/ui/badge'

import type { CycleState } from '../model/schema'

// 상태 배지는 트래커의 다른 상태들과 같은 문법(아이콘 + 라벨). 진행 중만 색을 갖는다 — 예정과 완료는
// 배경이지 신호가 아니다.
export function CycleStateBadge({ state }: { state: CycleState }) {
  const t = useTranslations('tracker')
  if (state === 'active')
    return (
      <Badge tone="info">
        <Timer className="size-3" strokeWidth={2} />
        {t('cycleState.active')}
      </Badge>
    )
  if (state === 'completed')
    return (
      <Badge tone="neutral">
        <CheckCircle2 className="size-3" strokeWidth={2} />
        {t('cycleState.completed')}
      </Badge>
    )
  return (
    <Badge tone="outline">
      <CalendarClock className="size-3" strokeWidth={2} />
      {t('cycleState.upcoming')}
    </Badge>
  )
}
