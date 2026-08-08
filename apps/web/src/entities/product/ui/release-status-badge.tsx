import { CheckCircle2, CircleDashed, CircleSlash, type LucideIcon } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { Badge } from '@/shared/ui/badge'

import type { ReleaseStatus } from '../model/schema'

const TONE: Record<ReleaseStatus, 'neutral' | 'success' | 'outline'> = {
  // 계획됨은 아직 아무것도 나가지 않은 상태 — 진행색을 주면 날짜가 일처럼 보인다.
  planned: 'outline',
  released: 'success',
  cancelled: 'neutral',
}

const ICON: Record<ReleaseStatus, LucideIcon> = {
  planned: CircleDashed,
  released: CheckCircle2,
  cancelled: CircleSlash,
}

export function ReleaseStatusBadge({ status }: { status: ReleaseStatus }) {
  const t = useTranslations('productsPage')
  const Icon = ICON[status]
  return (
    <Badge tone={TONE[status]}>
      <Icon className="size-3" strokeWidth={2} />
      {t(`releaseStatus.${status}`)}
    </Badge>
  )
}
