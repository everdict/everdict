import Link from 'next/link'

import { SubmitRunForm } from '@/features/submit-run'
import { connectionsResponseSchema, type ConnectionMeta } from '@/entities/connection'
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
  let connections: ConnectionMeta[] = []
  let runtimes: { id: string }[] = []
  let runners: { id: string; label: string }[] = []
  if (allowed) {
    try {
      harnesses = harnessesSchema.parse(await controlPlane.listHarnesses(ctx))
    } catch {
      // 하니스 목록 실패해도 폼은 텍스트 입력으로 동작
    }
    // 비공개 repo 시드용 연결 picker — 연결은 개인 소유라 내(subject) 연결 메타만(역할 게이트 없음). 실패/없음이면 public 만.
    try {
      connections = connectionsResponseSchema.parse(
        await controlPlane.listConnections(ctx)
      ).connections
    } catch {
      // 연결 목록 실패해도 폼은 public repo 로 동작
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
            connections={connections}
            runtimes={runtimes}
            runners={runners}
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
