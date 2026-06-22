import Link from 'next/link'

import { judgesSchema } from '@/entities/judge'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Badge } from '@/shared/ui/badge'
import { buttonVariants } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Card, CardContent } from '@/shared/ui/card'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

export default async function JudgesPage() {
  const { principal, ctx } = await currentPrincipal()
  let error: string | undefined
  let judges = judgesSchema.parse([])
  try {
    judges = judgesSchema.parse(await controlPlane.listJudges(ctx))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Judge"
        description="이 워크스페이스가 등록한 Agent Judge + 공유(기본). model(LLM/VLM 호출) 또는 harness(에이전트 위임)."
        actions={
          can(principal?.roles, 'judges:write') ? (
            <Link href="/dashboard/judges/new" className={buttonVariants({ size: 'sm' })}>
              Judge 등록
            </Link>
          ) : null
        }
      />
      {error ? (
        <Callout tone="danger">컨트롤플레인 연결 실패: {error}</Callout>
      ) : judges.length === 0 ? (
        <EmptyState
          title="등록된 Judge 가 없습니다."
          hint="member 이상이면 'Judge 등록'으로 model/harness judge 를 올리거나, API/MCP(create_judge)로 등록하세요."
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {judges.map((j) => (
            <Link key={j.id} href={`/dashboard/judges/${encodeURIComponent(j.id)}`}>
              <Card className="transition-colors hover:border-primary/40">
                <CardContent className="space-y-2 pt-5">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold">{j.id}</span>
                    <Badge tone={j.owner === principal?.workspace ? 'success' : 'neutral'}>
                      {j.owner === principal?.workspace ? 'owned' : 'shared'}
                    </Badge>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {j.versions.map((v) => (
                      <code
                        key={v}
                        className="rounded-md border border-border bg-muted/40 px-2 py-0.5 font-mono text-xs"
                      >
                        {v}
                      </code>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
