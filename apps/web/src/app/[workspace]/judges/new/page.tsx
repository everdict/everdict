import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'

import { RegisterJudgeForm } from '@/features/register-judge'
import { runtimesSchema } from '@/entities/runtime'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Card } from '@/shared/ui/card'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

export default async function NewJudgePage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace } = await params
  const { principal, ctx } = await currentPrincipal()
  const allowed = can(principal?.roles, 'judges:write')

  // harness judge 의 런타임 셀렉터용 — 실패해도 폼은 뜬다(빈 목록 = co-locate/기본만).
  let runtimes: { id: string }[] = []
  try {
    runtimes = runtimesSchema.parse(await controlPlane.listRuntimes(ctx))
  } catch {
    runtimes = []
  }

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link
          href={`/${workspace}/judges`}
          className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
          Judge
        </Link>
        <PageHeader
          title="Judge 등록"
          description="Agent Judge(model | harness)를 이 워크스페이스 소유로 등록합니다."
        />
      </div>
      {allowed ? (
        <Card className="p-5">
          <RegisterJudgeForm runtimes={runtimes} />
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
