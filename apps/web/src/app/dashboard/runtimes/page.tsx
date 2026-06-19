import Link from 'next/link'

import { runtimesSchema } from '@/entities/runtime'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Badge } from '@/shared/ui/badge'
import { buttonVariants } from '@/shared/ui/button'
import { Card, CardContent } from '@/shared/ui/card'
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
        description="이 워크스페이스가 실행에 쓸 인프라(local / nomad / k8s) + 공용. 스코어카드 실행 시 선택."
        actions={
          can(principal?.roles, 'runtimes:write') ? (
            <Link href="/dashboard/runtimes/new" className={buttonVariants({ size: 'sm' })}>
              런타임 등록
            </Link>
          ) : null
        }
      />
      {error ? (
        <Card className="border-destructive/30 bg-destructive/5 p-5 text-sm text-destructive">
          컨트롤플레인 연결 실패: {error}
        </Card>
      ) : runtimes.length === 0 ? (
        <EmptyState
          title="등록된 런타임이 없습니다."
          hint="admin 이 '런타임 등록'으로 Nomad/K8s/local 을 정의하거나, API/MCP(create_runtime)로 등록하세요. 자격증명은 시크릿으로."
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {runtimes.map((r) => (
            <Link key={r.id} href={`/dashboard/runtimes/${encodeURIComponent(r.id)}`}>
              <Card className="transition-colors hover:border-primary/40">
                <CardContent className="space-y-2 pt-5">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold">{r.id}</span>
                    <Badge tone={r.owner === principal?.workspace ? 'success' : 'neutral'}>
                      {r.owner === principal?.workspace ? 'owned' : 'shared'}
                    </Badge>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {r.versions.map((v) => (
                      <code key={v} className="rounded-md bg-secondary px-1.5 py-0.5 text-xs">
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
