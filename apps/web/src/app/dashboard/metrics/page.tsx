import Link from 'next/link'
import { Gauge, Plus } from 'lucide-react'

import { metricsSchema } from '@/entities/metric'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

export default async function MetricsPage() {
  const { principal, ctx } = await currentPrincipal()
  let error: string | undefined
  let metrics = metricsSchema.parse([])
  try {
    metrics = metricsSchema.parse(await controlPlane.listMetrics(ctx))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="메트릭"
        description={`${metrics.length}건 · 런타임 정의 합격규칙(threshold). 스코어카드 실행/인제스트 시 선택하면 결과 점수 위에 적용됩니다.`}
        actions={
          can(principal?.roles, 'metrics:write') ? (
            <Link href="/dashboard/metrics/new">
              <Button size="sm">
                <Plus className="size-4" />
                메트릭 정의
              </Button>
            </Link>
          ) : null
        }
      />
      {error ? (
        <Callout tone="danger">컨트롤플레인 연결 실패: {error}</Callout>
      ) : metrics.length === 0 ? (
        <EmptyState
          icon={<Gauge />}
          title="정의된 메트릭이 없습니다."
          hint="member 이상이면 '메트릭 정의'로 cost·latency·judge 위 합격규칙을 만들거나, API(POST /metrics)로 등록하세요."
        />
      ) : (
        <div className="space-y-2">
          {metrics.map((m) => (
            <Link
              key={m.id}
              href={`/dashboard/metrics/${encodeURIComponent(m.id)}`}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-3.5 shadow-raise transition-colors hover:border-border-strong hover:bg-elevated"
            >
              <div className="flex min-w-0 items-center gap-3">
                <span className="grid size-8 shrink-0 place-items-center rounded-md bg-elevated text-muted-foreground ring-1 ring-inset ring-border">
                  <Gauge className="size-[18px]" strokeWidth={1.75} />
                </span>
                <div className="min-w-0 space-y-1">
                  <div className="truncate text-[13px] font-[560] text-foreground">{m.id}</div>
                  <div className="flex flex-wrap gap-1">
                    {m.versions.map((v) => (
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
              <Badge tone={m.owner === principal?.workspace ? 'success' : 'neutral'}>
                {m.owner === principal?.workspace ? 'owned' : 'shared'}
              </Badge>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
