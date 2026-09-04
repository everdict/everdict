import { CheckCircle2, CircleDashed, CircleSlash, type LucideIcon } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { Badge } from '@/shared/ui/badge'

import type { ReleaseStatus } from '../model/schema'

const TONE: Record<ReleaseStatus, 'neutral' | 'success' | 'outline'> = {
  // `planned` is the state where nothing has shipped yet — given a progress colour, a DATE looks like work.
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
