import Link from 'next/link'

import { judgeSpecSchema, type JudgeSpec } from '@/entities/judge'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Badge } from '@/shared/ui/badge'
import { Callout } from '@/shared/ui/callout'
import { Card, CardContent } from '@/shared/ui/card'
import { PageHeader } from '@/shared/ui/page-header'
import { SectionHeader } from '@/shared/ui/section-header'

export const dynamic = 'force-dynamic'

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-mono text-sm">{value}</dd>
    </div>
  )
}

export default async function JudgeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const ctx = await authContext()

  let judge: JudgeSpec | undefined
  let error: string | undefined
  try {
    judge = judgeSpecSchema.parse(await controlPlane.getJudge(ctx, id, 'latest'))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  if (!judge) {
    return (
      <div className="space-y-6">
        <PageHeader title="Judge" />
        <Callout tone="danger">Judge 를 불러올 수 없습니다: {error}</Callout>
        <Link
          href="/dashboard/judges"
          className="text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          ← Judge 로
        </Link>
      </div>
    )
  }

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <Link
          href="/dashboard/judges"
          className="text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          ← Judge
        </Link>
        <PageHeader
          title={judge.id}
          description={judge.description ?? 'Agent Judge'}
          actions={
            <div className="flex gap-2">
              <Badge tone="info">{judge.kind}</Badge>
              <Badge tone="neutral">v{judge.version} (latest)</Badge>
            </div>
          }
        />
      </div>

      <Card>
        <CardContent className="grid grid-cols-2 gap-4 pt-5 sm:grid-cols-3">
          {judge.kind === 'model' ? (
            <>
              <Meta label="provider" value={judge.provider ?? '—'} />
              <Meta label="model" value={judge.model ?? '—'} />
              <Meta label="inputs" value={(judge.inputs ?? []).join(', ') || '—'} />
              {judge.passThreshold != null && (
                <Meta label="pass 임계값" value={String(judge.passThreshold)} />
              )}
            </>
          ) : (
            <Meta
              label="harness"
              value={judge.harness ? `${judge.harness.id}@${judge.harness.version}` : '—'}
            />
          )}
        </CardContent>
      </Card>

      {judge.rubric && (
        <section className="space-y-3">
          <SectionHeader title="Rubric" />
          <pre className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-xs text-muted-foreground whitespace-pre-wrap">
            {judge.rubric}
          </pre>
        </section>
      )}
    </div>
  )
}
