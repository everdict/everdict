import Link from 'next/link'

import { SubmitRunForm } from '@/features/submit-run'
import { harnessesSchema, type Harness } from '@/entities/harness'
import { runnersResponseSchema } from '@/entities/runner'
import { runtimesSchema } from '@/entities/runtime'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Card } from '@/shared/ui/card'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

export default async function NewRunPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace } = await params
  const { principal, ctx } = await currentPrincipal()
  const allowed = can(principal?.roles, 'runs:submit')

  let harnesses: Harness[] = []
  let runtimes: { id: string }[] = []
  let runners: { id: string; label: string }[] = []
  let hasWorkspaceRunners = false
  if (allowed) {
    try {
      harnesses = harnessesSchema.parse(await controlPlane.listHarnesses(ctx))
    } catch {
      // 하니스 목록 실패해도 폼은 텍스트 입력으로 동작
    }
    // 런타임 picker — 등록 런타임(테넌트 소유+_shared). 실패/없음이면 기본 백엔드만.
    try {
      runtimes = runtimesSchema.parse(await controlPlane.listRuntimes(ctx))
    } catch {
      // 런타임 목록 실패해도 폼은 기본 백엔드로 동작
    }
    // 내 로컬 러너 picker — 개인 소유 디바이스. 실패/없음이면 노출 안 함.
    try {
      runners = runnersResponseSchema.parse(await controlPlane.listRunners(ctx)).runners
    } catch {
      // 러너 목록 실패해도 폼은 동작
    }
    // 워크스페이스에 팀 공유 러너가 있으면 self:ws 풀 옵션 노출(members:read 로스터). 실패/없음이면 미노출.
    try {
      hasWorkspaceRunners =
        runnersResponseSchema.parse(await controlPlane.listWorkspaceRunners(ctx)).runners.length > 0
    } catch {
      // 로스터 실패해도 폼은 동작(풀 옵션만 숨김)
    }
  }

  return (
    <div className="space-y-6">
      <Link
        href={`/${workspace}/runs`}
        className="text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        ← 활동
      </Link>
      <PageHeader title="새 실행" description="하니스를 골라 한 번 실행해보세요." />
      {allowed ? (
        <Card className="p-6">
          <SubmitRunForm
            harnesses={harnesses}
            runtimes={runtimes}
            runners={runners}
            hasWorkspaceRunners={hasWorkspaceRunners}
          />
        </Card>
      ) : (
        <EmptyState
          title="실행을 시작할 권한이 없어요."
          hint="워크스페이스 관리자에게 권한을 요청해보세요."
        />
      )}
    </div>
  )
}
