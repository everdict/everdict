import { Suspense } from 'react'
import { getTranslations } from 'next-intl/server'

import {
  ActivitySkeleton,
  PulseSkeleton,
  WorkspaceActivity,
  WorkspacePulseView,
} from '@/widgets/workspace-pulse'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// 홈 = 워크스페이스의 현황판.
//
// 예전의 홈은 이니셔티브 readiness → 회귀 → 평가 대시보드 → 최근 실행이었다. 전부 참인 답이었지만 전부
// 평가 축의 답이라, 이 제품이 이슈·사이클·목표·에이전트·파일·지식을 다룬다는 사실이 홈에서는 보이지 않았다.
// 지금의 홈은 두 가지만 한다: **지금 어떤 상태인가**(현황 타일)와 **어느 쪽으로 가고 있나**(추이), 그 아래에
// 전 축의 활동 피드. 팀별 비교는 두지 않는다 — 현황판이 성과표가 되는 순간 원래의 질문이 사라진다(사용자 결정).
//
// Suspense 가 둘인 이유: 펄스(집계 한 번)와 활동 피드(이벤트 로그 + 멤버 디렉터리)는 서로를 기다릴 이유가
// 없다. 하나의 `Promise.all` 로 묶으면 둘 중 느린 쪽이 화면 전체의 속도가 된다.
export default async function OverviewPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace } = await params
  const t = await getTranslations('overviewPage')

  return (
    <div className="@container space-y-7">
      <PageHeader title={t('title')} description={t('description')} />

      <Suspense fallback={<PulseSkeleton />}>
        <WorkspacePulseView workspace={workspace} />
      </Suspense>

      <Suspense fallback={<ActivitySkeleton />}>
        <WorkspaceActivity workspace={workspace} />
      </Suspense>
    </div>
  )
}
