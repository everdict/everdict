import Link from 'next/link'
import { Database } from 'lucide-react'

import { datasetsSchema } from '@/entities/dataset'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Badge } from '@/shared/ui/badge'
import { buttonVariants } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
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
        description={`${datasets.length}건 · 워크스페이스 + 공유(벤치마크) · 하니스 무관, 어느 하니스든 같은 케이스로 평가`}
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
          icon={<Database />}
          title="등록된 데이터셋이 없습니다."
          hint="member 이상이면 '데이터셋 등록'으로 eval 케이스 묶음을 올리거나, API/MCP(create_dataset)로 등록하세요."
        />
      ) : (
        <div className="space-y-2">
          {datasets.map((d) => (
            <Link
              key={d.id}
              href={`/dashboard/datasets/${encodeURIComponent(d.id)}`}
              className="group flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-3.5 shadow-raise transition-colors hover:border-border-strong hover:bg-elevated"
            >
              <div className="flex min-w-0 items-center gap-3">
                <span className="grid size-8 shrink-0 place-items-center rounded-md bg-elevated text-muted-foreground ring-1 ring-inset ring-border group-hover:text-foreground">
                  <Database className="size-[18px]" strokeWidth={1.75} />
                </span>
                <div className="min-w-0 space-y-1.5">
                  <div className="truncate text-[13px] font-[560] text-foreground">{d.id}</div>
                  <div className="flex flex-wrap gap-1">
                    {d.versions.map((v) => (
                      <code
                        key={v}
                        className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground ring-1 ring-inset ring-border"
                      >
                        {v}
                      </code>
                    ))}
                  </div>
                </div>
              </div>
              <Badge tone={d.owner === principal?.workspace ? 'success' : 'neutral'}>
                {d.owner === principal?.workspace ? 'owned' : 'shared'}
              </Badge>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
