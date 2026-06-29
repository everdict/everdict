import Link from 'next/link'
import { ChevronLeft, Lock } from 'lucide-react'

import { RegisterRuntimeForm } from '@/features/register-runtime'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { Card } from '@/shared/ui/card'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

export default async function NewRuntimePage({
  params,
}: {
  params: Promise<{ workspace: string }>
}) {
  const { workspace } = await params
  const { principal } = await currentPrincipal()
  const allowed = can(principal?.roles, 'runtimes:write')

  return (
    <div className="space-y-6">
      <Link
        href={`/${workspace}/runtimes`}
        className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronLeft className="size-3.5" />
        런타임
      </Link>
      <PageHeader
        title="런타임 등록"
        description="실행 인프라(nomad | k8s)를 이 워크스페이스 소유로 등록합니다."
      />
      {allowed ? (
        <Card className="p-5">
          <RegisterRuntimeForm />
        </Card>
      ) : (
        <EmptyState
          icon={<Lock />}
          title="런타임 등록 권한이 없습니다."
          hint="이 워크스페이스의 멤버십이 필요합니다(runtimes:write). 등록은 role 무관이지만, 먼저 워크스페이스에 속해야 합니다."
        />
      )}
    </div>
  )
}
