import Link from 'next/link'

import { RegisterJudgeForm } from '@/features/register-judge'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { Card } from '@/shared/ui/card'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

export default async function NewJudgePage() {
  const { principal } = await currentPrincipal()
  const allowed = can(principal?.roles, 'judges:write')

  return (
    <div className="space-y-6">
      <Link href="/dashboard/judges" className="text-sm text-muted-foreground hover:text-foreground">
        ← Judge
      </Link>
      <PageHeader title="Judge 등록" description="Agent Judge(model | harness)를 이 워크스페이스 소유로 등록합니다." />
      {allowed ? (
        <Card className="p-6">
          <RegisterJudgeForm />
        </Card>
      ) : (
        <EmptyState
          title="Judge 등록 권한이 없습니다."
          hint="member 이상 역할이 필요합니다(judges:write). 워크스페이스 관리자에게 문의하세요."
        />
      )}
    </div>
  )
}
