import Link from 'next/link'

import { metricsSchema } from '@/entities/metric'
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
        description="런타임에 정의하는 합격규칙(threshold). 스코어카드 실행/인제스트 시 선택하면 결과 점수 위에 적용됩니다."
        actions={
          can(principal?.roles, 'metrics:write') ? (
            <Link href="/dashboard/metrics/new" className={buttonVariants({ size: 'sm' })}>
              메트릭 정의
            </Link>
          ) : null
        }
      />
      {error ? (
        <Callout tone="danger">컨트롤플레인 연결 실패: {error}</Callout>
      ) : metrics.length === 0 ? (
        <EmptyState
          title="정의된 메트릭이 없습니다."
          hint="member 이상이면 '메트릭 정의'로 cost·latency·judge 위 합격규칙을 만들거나, API(POST /metrics)로 등록하세요."
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {metrics.map((m) => (
            <Link key={m.id} href={`/dashboard/metrics/${encodeURIComponent(m.id)}`}>
              <Card className="transition-colors hover:border-primary/40">
                <CardContent className="space-y-2 pt-5">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold">{m.id}</span>
                    <Badge tone={m.owner === principal?.workspace ? 'success' : 'neutral'}>
                      {m.owner === principal?.workspace ? 'owned' : 'shared'}
                    </Badge>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {m.versions.map((v) => (
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
