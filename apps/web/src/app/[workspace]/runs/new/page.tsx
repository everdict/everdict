import Link from 'next/link'

import { SubmitRunForm } from '@/features/submit-run'
import { connectionsResponseSchema, type ConnectionMeta } from '@/entities/connection'
import { harnessesSchema, type Harness } from '@/entities/harness'
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
  }

  return (
    <div className="space-y-6">
      <Link
        href={`/${workspace}/runs`}
        className="text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        ← Runs
      </Link>
      <PageHeader title="새 run" description="하니스를 골라 평가를 제출합니다." />
      {allowed ? (
        <Card className="p-6">
          <SubmitRunForm harnesses={harnesses} connections={connections} />
        </Card>
      ) : (
        <EmptyState
          title="run 제출 권한이 없습니다."
          hint="member 이상 역할이 필요합니다(runs:submit). 워크스페이스 관리자에게 문의하세요."
        />
      )}
    </div>
  )
}
