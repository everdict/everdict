import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'

import { RegisterDatasetForm } from '@/features/register-dataset'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { Card } from '@/shared/ui/card'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

export default async function NewDatasetPage() {
  const { principal } = await currentPrincipal()
  const allowed = can(principal?.roles, 'datasets:write')

  return (
    <div className="space-y-6">
      <Link
        href="/dashboard/datasets"
        className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronLeft className="size-3.5" />
        데이터셋
      </Link>
      <PageHeader
        title="데이터셋 등록"
        description="eval 케이스 묶음을 이 워크스페이스 소유로 등록합니다."
      />
      {allowed ? (
        <Card className="p-5">
          <RegisterDatasetForm />
        </Card>
      ) : (
        <EmptyState
          title="데이터셋 등록 권한이 없습니다."
          hint="member 이상 역할이 필요합니다(datasets:write). 워크스페이스 관리자에게 문의하세요."
        />
      )}
    </div>
  )
}
