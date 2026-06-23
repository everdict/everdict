import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'

import { metricSpecSchema, type MetricSpec } from '@/entities/metric'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Badge } from '@/shared/ui/badge'
import { Callout } from '@/shared/ui/callout'
import { Card } from '@/shared/ui/card'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

const OP_SYM: Record<string, string> = { lte: '≤', gte: '≥', lt: '<', gt: '>', eq: '=' }

function Prop({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-[510] uppercase tracking-wide text-faint">{label}</dt>
      <dd className="mt-1 truncate font-mono text-[13px] text-foreground">{value}</dd>
    </div>
  )
}

function BackLink({ workspace }: { workspace: string }) {
  return (
    <Link
      href={`/${workspace}/metrics`}
      className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
    >
      <ChevronLeft className="size-3.5" />
      메트릭
    </Link>
  )
}

export default async function MetricDetailPage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>
}) {
  const { workspace, id } = await params
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
      <div className="space-y-5">
        <BackLink workspace={workspace} />
        <PageHeader title="메트릭" />
        <Callout tone="danger">메트릭을 불러올 수 없습니다: {error}</Callout>
      </div>
    )
  }

  const rule = `${metric.source ?? '?'} ${OP_SYM[metric.op ?? ''] ?? metric.op ?? '?'} ${metric.threshold ?? '?'} → pass`

  return (
    <div className="space-y-7">
      <div className="space-y-3">
        <BackLink workspace={workspace} />
        <PageHeader
          title={metric.id}
          description={metric.description ?? '런타임 정의 합격규칙'}
          actions={<Badge tone="info">{`${metric.id}@${metric.version}`}</Badge>}
        />
      </div>

      <div className="rounded-lg border border-border bg-muted/30 px-3.5 py-2.5 font-mono text-[13px] text-foreground">
        {rule}
      </div>

      <Card className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
        <Prop label="kind" value={metric.kind} />
        <Prop label="source" value={metric.source ?? '–'} />
        <Prop label="op" value={metric.op ?? '–'} />
        <Prop label="threshold" value={String(metric.threshold ?? '–')} />
        <Prop label="emitted metric" value={metric.metric ?? metric.id} />
        <Prop label="version" value={metric.version} />
      </Card>

      <p className="text-[12px] leading-relaxed text-muted-foreground">
        스코어카드 실행 폼에서 이 메트릭을 선택하면 run 후 결과 점수 위에 적용되어 요약·추이·비교에
        반영됩니다.
      </p>
    </div>
  )
}
