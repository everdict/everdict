import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'

import { judgeSpecSchema, type JudgeSpec } from '@/entities/judge'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Badge } from '@/shared/ui/badge'
import { Callout } from '@/shared/ui/callout'
import { Card } from '@/shared/ui/card'
import { PageHeader } from '@/shared/ui/page-header'
import { SectionHeader } from '@/shared/ui/section-header'

export const dynamic = 'force-dynamic'

function Prop({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-[510] uppercase tracking-wide text-faint">{label}</dt>
      <dd className="mt-1 truncate font-mono text-[13px] text-foreground">{value}</dd>
    </div>
  )
}

function BackLink() {
  return (
    <Link
      href="/dashboard/judges"
      className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
    >
      <ChevronLeft className="size-3.5" />
      Judge
    </Link>
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
      <div className="space-y-5">
        <BackLink />
        <PageHeader title="Judge" />
        <Callout tone="danger">Judge 를 불러올 수 없습니다: {error}</Callout>
      </div>
    )
  }

  return (
    <div className="space-y-7">
      <div className="space-y-3">
        <BackLink />
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

      <Card className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
        {judge.kind === 'model' ? (
          <>
            <Prop label="provider" value={judge.provider ?? '—'} />
            <Prop label="model" value={judge.model ?? '—'} />
            <Prop label="inputs" value={(judge.inputs ?? []).join(', ') || '—'} />
            {judge.passThreshold != null && (
              <Prop label="pass 임계값" value={String(judge.passThreshold)} />
            )}
          </>
        ) : (
          <Prop
            label="harness"
            value={judge.harness ? `${judge.harness.id}@${judge.harness.version}` : '—'}
          />
        )}
      </Card>

      {judge.rubric && (
        <section className="space-y-2.5">
          <SectionHeader title="Rubric" />
          <pre className="whitespace-pre-wrap rounded-lg border border-border bg-muted/40 px-4 py-3 font-mono text-[12px] leading-relaxed text-muted-foreground">
            {judge.rubric}
          </pre>
        </section>
      )}
    </div>
  )
}
