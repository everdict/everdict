import Link from 'next/link'

import { RegisterRuntimeForm } from '@/features/register-runtime'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { Card } from '@/shared/ui/card'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

export default async function NewRuntimePage() {
  const { principal } = await currentPrincipal()
  const allowed = can(principal?.roles, 'runtimes:write')

  return (
    <div className="space-y-6">
      <Link
        href="/dashboard/runtimes"
        className="text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        ← 런타임
      </Link>
      <PageHeader
        title="런타임 등록"
        description="실행 인프라(local | nomad | k8s)를 이 워크스페이스 소유로 등록합니다."
      />
      {allowed ? (
        <Card className="p-6">
          <RegisterRuntimeForm />
        </Card>
      ) : (
        <EmptyState
          title="런타임 등록 권한이 없습니다."
          hint="admin 역할이 필요합니다(runtimes:write). 실행 인프라 정의는 admin 전용입니다."
        />
      )}
    </div>
  )
}
