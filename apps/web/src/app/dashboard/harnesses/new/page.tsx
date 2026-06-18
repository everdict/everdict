import Link from 'next/link'

import { RegisterHarnessWizard } from '@/features/register-harness'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { Card } from '@/shared/ui/card'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

export default async function NewHarnessPage() {
  const { principal } = await currentPrincipal()
  const allowed = can(principal?.roles, 'harnesses:register')

  return (
    <div className="space-y-6">
      <Link href="/dashboard/harnesses" className="text-sm text-muted-foreground hover:text-foreground">
        ← 하니스
      </Link>
      <PageHeader title="하니스 등록" description="HarnessSpec 을 이 워크스페이스 소유로 등록합니다." />
      {allowed ? (
        <Card className="p-6">
          <RegisterHarnessWizard />
        </Card>
      ) : (
        <EmptyState
          title="하니스 등록 권한이 없습니다."
          hint="admin 역할이 필요합니다(harnesses:register). 워크스페이스 관리자에게 문의하세요."
        />
      )}
    </div>
  )
}
