import Link from 'next/link'

import { datasetSchema, type Dataset } from '@/entities/dataset'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Badge } from '@/shared/ui/badge'
import { Callout } from '@/shared/ui/callout'
import { Card, CardContent } from '@/shared/ui/card'
import { PageHeader } from '@/shared/ui/page-header'
import { SectionHeader } from '@/shared/ui/section-header'

export const dynamic = 'force-dynamic'

export default async function DatasetDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const ctx = await authContext()

  let dataset: Dataset | undefined
  let error: string | undefined
  try {
    dataset = datasetSchema.parse(await controlPlane.getDataset(ctx, id, 'latest'))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  if (!dataset) {
    return (
      <div className="space-y-6">
        <PageHeader title="데이터셋" />
        <Callout tone="danger">데이터셋을 불러올 수 없습니다: {error}</Callout>
        <Link
          href="/dashboard/datasets"
          className="text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          ← 데이터셋으로
        </Link>
      </div>
    )
  }

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <Link
          href="/dashboard/datasets"
          className="text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          ← 데이터셋
        </Link>
        <PageHeader
          title={dataset.id}
          description={dataset.description ?? '하니스 무관 eval 케이스 묶음'}
          actions={<Badge tone="neutral">v{dataset.version} (latest)</Badge>}
        />
      </div>

      <section className="space-y-3">
        <SectionHeader title={`케이스 (${dataset.cases.length})`} />
        {dataset.cases.length === 0 ? (
          <p className="text-sm text-muted-foreground">케이스가 없습니다.</p>
        ) : (
          <div className="space-y-2">
            {dataset.cases.map((c) => (
              <Card key={c.id}>
                <CardContent className="space-y-1.5 pt-5">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-mono text-sm font-medium">{c.id}</span>
                    <div className="flex flex-wrap gap-1">
                      {c.env?.kind && (
                        <code className="rounded-md bg-secondary px-1.5 py-0.5 text-xs">
                          {c.env.kind}
                        </code>
                      )}
                      {c.graders.map((g) => (
                        <code key={g.id} className="rounded-md bg-secondary px-1.5 py-0.5 text-xs">
                          {g.id}
                        </code>
                      ))}
                    </div>
                  </div>
                  <p className="text-sm text-muted-foreground">{c.task}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
