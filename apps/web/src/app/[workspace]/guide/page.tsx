import { getTranslations } from 'next-intl/server'

import { StartTourButton, UsageGuide } from '@/features/get-started'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// 신규 유저 사용 가이드 — everdict eval 흐름을 한눈에 보고 각 단계로 진입. 워크스페이스 스코프([workspace] 레이아웃이 멤버십 검증).
export default async function GuidePage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace } = await params
  const t = await getTranslations('guidePage')
  return (
    <div className="space-y-6">
      <PageHeader title={t('title')} description={t('description')} actions={<StartTourButton />} />
      <UsageGuide workspace={workspace} />
    </div>
  )
}
