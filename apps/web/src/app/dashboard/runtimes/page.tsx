import Link from 'next/link'
import { Server } from 'lucide-react'

import { runtimesSchema } from '@/entities/runtime'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Badge } from '@/shared/ui/badge'
import { buttonVariants } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

export default async function RuntimesPage() {
  const { principal, ctx } = await currentPrincipal()
  let error: string | undefined
  let runtimes = runtimesSchema.parse([])
  try {
    runtimes = runtimesSchema.parse(await controlPlane.listRuntimes(ctx))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="런타임"
        description={`${runtimes.length}건 · 실행 인프라(local / nomad / k8s) + 공용. 스코어카드 실행 시 선택.`}
        actions={
          can(principal?.roles, 'runtimes:write') ? (
            <Link href="/dashboard/runtimes/new" className={buttonVariants({ size: 'sm' })}>
              런타임 등록
            </Link>
          ) : null
        }
      />
      {error ? (
        <Callout tone="danger">컨트롤플레인 연결 실패: {error}</Callout>
      ) : runtimes.length === 0 ? (
        <EmptyState
          icon={<Server />}
          title="등록된 런타임이 없습니다."
          hint="'런타임 등록'으로 Nomad/K8s/local 을 정의하거나(워크스페이스 멤버 누구나), API/MCP(create_runtime)로 등록하세요. 자격증명 값은 시크릿으로(admin)."
        />
      ) : (
        <div className="space-y-2">
          {runtimes.map((r) => {
            const owned = r.owner === principal?.workspace
            return (
              <Link
                key={r.id}
                href={`/dashboard/runtimes/${encodeURIComponent(r.id)}`}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-3.5 shadow-raise transition-colors hover:border-border-strong hover:bg-elevated"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span className="grid size-8 shrink-0 place-items-center rounded-md bg-elevated text-muted-foreground ring-1 ring-inset ring-border">
                    <Server className="size-[18px]" strokeWidth={1.75} />
                  </span>
                  <div className="min-w-0 space-y-1.5">
                    <div className="truncate text-[13px] font-[560] text-foreground">{r.id}</div>
                    <div className="flex flex-wrap gap-1">
                      {r.versions.map((v) => (
                        <code
                          key={v}
                          className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground ring-1 ring-inset ring-border"
                        >
                          {v}
                        </code>
                      ))}
                    </div>
                  </div>
                </div>
                <Badge tone={owned ? 'success' : 'neutral'}>{owned ? 'owned' : 'shared'}</Badge>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
