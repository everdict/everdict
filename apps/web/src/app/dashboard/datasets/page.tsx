import Link from 'next/link'

import { datasetsSchema } from '@/entities/dataset'
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

export default async function DatasetsPage() {
  const { principal, ctx } = await currentPrincipal()
  let error: string | undefined
  let datasets = datasetsSchema.parse([])
  try {
    datasets = datasetsSchema.parse(await controlPlane.listDatasets(ctx))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="데이터셋"
        description="이 워크스페이스가 등록한 데이터셋 + 공유(벤치마크). 하니스 무관 — 어느 하니스든 같은 케이스로 평가."
        actions={
          can(principal?.roles, 'datasets:write') ? (
            <div className="flex gap-2">
              <Link
                href="/dashboard/datasets/recipes"
                className={buttonVariants({ size: 'sm', variant: 'secondary' })}
              >
                레시피
              </Link>
              <Link
                href="/dashboard/datasets/import"
                className={buttonVariants({ size: 'sm', variant: 'secondary' })}
              >
                벤치마크 추가
              </Link>
              <Link href="/dashboard/datasets/new" className={buttonVariants({ size: 'sm' })}>
                데이터셋 등록
              </Link>
            </div>
          ) : null
        }
      />
      {error ? (
        <Callout tone="danger">컨트롤플레인 연결 실패: {error}</Callout>
      ) : datasets.length === 0 ? (
        <EmptyState
          title="등록된 데이터셋이 없습니다."
          hint="member 이상이면 '데이터셋 등록'으로 eval 케이스 묶음을 올리거나, API/MCP(create_dataset)로 등록하세요."
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {datasets.map((d) => (
            <Link key={d.id} href={`/dashboard/datasets/${encodeURIComponent(d.id)}`}>
              <Card className="transition-colors hover:border-primary/40">
                <CardContent className="space-y-2 pt-5">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold">{d.id}</span>
                    <Badge tone={d.owner === principal?.workspace ? 'success' : 'neutral'}>
                      {d.owner === principal?.workspace ? 'owned' : 'shared'}
                    </Badge>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {d.versions.map((v) => (
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
