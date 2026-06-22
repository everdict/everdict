import Link from 'next/link'
import { Gavel, Plus } from 'lucide-react'

import { judgesSchema } from '@/entities/judge'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
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
        description={`${judges.length}건 · model(LLM/VLM 호출) 또는 harness(에이전트 위임). 워크스페이스 소유 + 공유(기본).`}
        actions={
          can(principal?.roles, 'judges:write') ? (
            <Link href="/dashboard/judges/new">
              <Button size="sm">
                <Plus className="size-4" />
                Judge 등록
              </Button>
            </Link>
          ) : null
        }
      />
      {error ? (
        <Callout tone="danger">컨트롤플레인 연결 실패: {error}</Callout>
      ) : judges.length === 0 ? (
        <EmptyState
          icon={<Gavel />}
          title="등록된 Judge 가 없습니다."
          hint="member 이상이면 'Judge 등록'으로 model/harness judge 를 올리거나, API/MCP(create_judge)로 등록하세요."
        />
      ) : (
        <div className="space-y-2">
          {judges.map((j) => (
            <Link
              key={j.id}
              href={`/dashboard/judges/${encodeURIComponent(j.id)}`}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-3.5 shadow-raise transition-colors hover:border-border-strong hover:bg-elevated"
            >
              <div className="flex min-w-0 items-center gap-3">
                <span className="grid size-8 shrink-0 place-items-center rounded-md bg-elevated text-muted-foreground ring-1 ring-inset ring-border">
                  <Gavel className="size-[18px]" strokeWidth={1.75} />
                </span>
                <div className="min-w-0 space-y-1">
                  <div className="truncate text-[13px] font-[560] text-foreground">{j.id}</div>
                  <div className="flex flex-wrap gap-1">
                    {j.versions.map((v) => (
                      <code
                        key={v}
                        className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[11px] text-secondary-foreground ring-1 ring-inset ring-border"
                      >
                        {v}
                      </code>
                    ))}
                  </div>
                </div>
              </div>
              <Badge tone={j.owner === principal?.workspace ? 'success' : 'neutral'}>
                {j.owner === principal?.workspace ? 'owned' : 'shared'}
              </Badge>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
