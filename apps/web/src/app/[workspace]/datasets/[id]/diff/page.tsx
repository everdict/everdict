import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'

import { DiffPicker } from '@/features/dataset-versions'
import {
  datasetDiffSchema,
  datasetsSchema,
  type DatasetDiff,
  type DatasetFieldChange,
} from '@/entities/dataset'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { sortSemverDesc } from '@/shared/lib/semver'
import { Badge } from '@/shared/ui/badge'
import { Callout } from '@/shared/ui/callout'
import { Card } from '@/shared/ui/card'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'
import { SectionHeader } from '@/shared/ui/section-header'

export const dynamic = 'force-dynamic'

export default async function DatasetDiffPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; id: string }>
  searchParams: Promise<{ base?: string; candidate?: string }>
}) {
  const { workspace, id } = await params
  const sp = await searchParams
  const ctx = await authContext()

  let versions: string[] = []
  try {
    const summary = datasetsSchema
      .parse(await controlPlane.listDatasets(ctx))
      .find((d) => d.id === id)
    if (summary) versions = sortSemverDesc(summary.versions)
  } catch {
    versions = []
  }

  // 기본값: candidate=최신, base=직전. 쿼리로 덮어쓸 수 있다.
  const candidate = sp.candidate ?? versions[0]
  const base = sp.base ?? versions[1]

  let diff: DatasetDiff | undefined
  let error: string | undefined
  if (base && candidate && base !== candidate) {
    try {
      diff = datasetDiffSchema.parse(await controlPlane.diffDataset(ctx, id, base, candidate))
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
  }

  return (
    <div className="space-y-7">
      <div className="space-y-3">
        <Link
          href={`/${workspace}/datasets/${encodeURIComponent(id)}`}
          className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
          {id}
        </Link>
        <PageHeader
          title="버전 비교"
          description="두 버전의 케이스와 메타가 어떻게 달라졌는지 봐요."
        />
      </div>

      {versions.length < 2 ? (
        <EmptyState
          title="버전이 2개 이상 있어야 비교할 수 있어요."
          hint="새 버전을 만들면 버전끼리 비교할 수 있어요."
        />
      ) : (
        <Card className="p-4">
          <DiffPicker id={id} versions={versions} base={base} candidate={candidate} />
        </Card>
      )}

      {error && <Callout tone="danger">비교하지 못했어요: {error}</Callout>}

      {diff && <DiffBody diff={diff} />}
    </div>
  )
}

function DiffBody({ diff }: { diff: DatasetDiff }) {
  return (
    <div className="space-y-7">
      <p className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted-foreground">
        base
        <code className="rounded-md border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px]">
          {diff.base}
        </code>
        → candidate
        <code className="rounded-md border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px]">
          {diff.candidate}
        </code>
      </p>

      <div className="flex flex-wrap gap-2">
        <Badge tone="success">+{diff.summary.added} 추가</Badge>
        <Badge tone="danger">−{diff.summary.removed} 삭제</Badge>
        <Badge tone="warning">~{diff.summary.changed} 변경</Badge>
        <Badge tone="neutral">{diff.summary.unchanged} 동일</Badge>
      </div>

      {diff.meta.length > 0 && (
        <section className="space-y-2.5">
          <SectionHeader title="데이터셋 메타 변경" />
          <Card className="divide-y divide-border p-0">
            {diff.meta.map((c) => (
              <FieldChangeRow key={c.field} change={c} />
            ))}
          </Card>
        </section>
      )}

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <CaseRefList title="추가된 케이스" tone="success" items={diff.added} empty="추가 없음" />
        <CaseRefList title="삭제된 케이스" tone="danger" items={diff.removed} empty="삭제 없음" />
      </section>

      <section className="space-y-2.5">
        <div className="flex items-center gap-2">
          <SectionHeader title="변경된 케이스" />
          <Badge tone="warning">{diff.changed.length}</Badge>
        </div>
        {diff.changed.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">변경된 케이스가 없어요.</p>
        ) : (
          <div className="space-y-3">
            {diff.changed.map((c) => (
              <Card key={c.id} className="space-y-2 p-4">
                <div className="flex items-center gap-2">
                  <code className="font-mono text-[12px] font-[510] text-foreground">{c.id}</code>
                  <span className="text-[11px] text-faint">
                    {c.changes.map((x) => x.field).join(' · ')}
                  </span>
                </div>
                <div className="divide-y divide-border rounded-lg border">
                  {c.changes.map((x) => (
                    <FieldChangeRow key={x.field} change={x} />
                  ))}
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

// 한 필드의 before → after(표시용 문자열). before 는 빨강/취소, after 는 초록.
function FieldChangeRow({ change }: { change: DatasetFieldChange }) {
  return (
    <div className="grid grid-cols-[88px_1fr] gap-3 px-3 py-2 text-[12px]">
      <div className="font-mono font-[510] text-muted-foreground">{change.field}</div>
      <div className="min-w-0 space-y-1">
        <div className="break-words font-mono text-destructive">
          <span className="select-none text-faint">- </span>
          {change.before}
        </div>
        <div className="break-words font-mono text-[var(--color-success)]">
          <span className="select-none text-faint">+ </span>
          {change.after}
        </div>
      </div>
    </div>
  )
}

function CaseRefList({
  title,
  tone,
  items,
  empty,
}: {
  title: string
  tone: 'success' | 'danger'
  items: DatasetDiff['added']
  empty: string
}) {
  return (
    <Card className="space-y-2.5 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-[13px] font-[560]">{title}</h2>
        <Badge tone={tone}>{items.length}</Badge>
      </div>
      {items.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">{empty}</p>
      ) : (
        <ul className="space-y-1.5 text-[13px]">
          {items.map((c) => (
            <li key={c.id} className="flex items-baseline gap-2">
              <code className="font-mono text-[12px] font-[510] text-foreground">{c.id}</code>
              <span className="truncate text-muted-foreground">{c.task}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
