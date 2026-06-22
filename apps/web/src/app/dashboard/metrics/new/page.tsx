import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'

import { RegisterMetricForm } from '@/features/register-metric'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { Card } from '@/shared/ui/card'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

export default async function NewMetricPage() {
  const { principal } = await currentPrincipal()
  const allowed = can(principal?.roles, 'metrics:write')

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link
          href="/dashboard/metrics"
          className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
          메트릭
        </Link>
        <PageHeader
          title="메트릭 정의"
          description="이미 산출된 메트릭(cost·latency·judge 등) 위에 합격 임계 규칙을 정의합니다."
        />
      </div>
      {allowed ? (
        <Card className="p-5">
          <RegisterMetricForm />
        </Card>
      ) : (
        <EmptyState
          title="메트릭 정의 권한이 없습니다."
          hint="member 이상 역할이 필요합니다(metrics:write). 워크스페이스 관리자에게 문의하세요."
        />
      )}
    </div>
  )
}
