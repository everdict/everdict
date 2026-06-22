import Link from 'next/link'

import { metricSpecSchema, type MetricSpec } from '@/entities/metric'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Badge } from '@/shared/ui/badge'
import { Callout } from '@/shared/ui/callout'
import { Card, CardContent } from '@/shared/ui/card'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

const OP_SYM: Record<string, string> = { lte: '≤', gte: '≥', lt: '<', gt: '>', eq: '=' }

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-mono text-sm">{value}</dd>
    </div>
  )
}

export default async function MetricDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const ctx = await authContext()

  let metric: MetricSpec | undefined
  let error: string | undefined
  try {
    metric = metricSpecSchema.parse(await controlPlane.getMetric(ctx, id, 'latest'))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  if (!metric) {
    return (
      <div className="space-y-6">
        <PageHeader title="메트릭" />
        <Callout tone="danger">메트릭을 불러올 수 없습니다: {error}</Callout>
        <Link
          href="/dashboard/metrics"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← 메트릭
        </Link>
      </div>
    )
  }

  const rule = `${metric.source ?? '?'} ${OP_SYM[metric.op ?? ''] ?? metric.op ?? '?'} ${metric.threshold ?? '?'} → pass`

  return (
    <div className="space-y-6">
      <Link
        href="/dashboard/metrics"
        className="text-sm text-muted-foreground hover:text-foreground"
      >
        ← 메트릭
      </Link>
      <PageHeader
        title={metric.id}
        description={metric.description ?? '런타임 정의 합격규칙'}
        actions={<Badge tone="info">{`${metric.id}@${metric.version}`}</Badge>}
      />
      <Card>
        <CardContent className="space-y-4 pt-5">
          <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 font-mono text-sm">
            {rule}
          </div>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
            <Meta label="kind" value={metric.kind} />
            <Meta label="source" value={metric.source ?? '–'} />
            <Meta label="op" value={metric.op ?? '–'} />
            <Meta label="threshold" value={String(metric.threshold ?? '–')} />
            <Meta label="emitted metric" value={metric.metric ?? metric.id} />
            <Meta label="version" value={metric.version} />
          </dl>
        </CardContent>
      </Card>
      <p className="text-xs text-muted-foreground">
        스코어카드 실행 폼에서 이 메트릭을 선택하면 run 후 결과 점수 위에 적용되어 요약·추이·비교에
        반영됩니다.
      </p>
    </div>
  )
}
