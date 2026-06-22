import Link from 'next/link'

import { RegisterModelForm } from '@/features/register-model'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { Card } from '@/shared/ui/card'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

export default async function NewModelPage() {
  const { principal } = await currentPrincipal()
  const allowed = can(principal?.roles, 'models:write')

  return (
    <div className="space-y-6">
      <Link
        href="/dashboard/models"
        className="text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        ← 모델
      </Link>
      <PageHeader
        title="모델 등록"
        description="추론/판정 모델(provider + 하부 모델 + baseUrl)을 이 워크스페이스 소유로 등록합니다."
      />
      {allowed ? (
        <Card className="p-6">
          <RegisterModelForm />
        </Card>
      ) : (
        <EmptyState
          title="모델 등록 권한이 없습니다."
          hint="member 이상 역할이 필요합니다(models:write). 워크스페이스 관리자에게 문의하세요."
        />
      )}
    </div>
  )
}
