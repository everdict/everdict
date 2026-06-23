import Link from 'next/link'
import { ChevronLeft, GitCompare } from 'lucide-react'

import { VersionSwitcher } from '@/features/dataset-versions'
import { datasetSchema, datasetsSchema, type Dataset } from '@/entities/dataset'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { sortSemverDesc } from '@/shared/lib/semver'
import { Badge } from '@/shared/ui/badge'
import { Callout } from '@/shared/ui/callout'
import { Card } from '@/shared/ui/card'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'
import { SectionHeader } from '@/shared/ui/section-header'
import { Table, TBody, TD, TH, THead, TR } from '@/shared/ui/table'

export const dynamic = 'force-dynamic'

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
      href={`/${workspace}/datasets`}
      className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
    >
      <ChevronLeft className="size-3.5" />
      데이터셋
    </Link>
  )
}

export default async function DatasetDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; id: string }>
  searchParams: Promise<{ version?: string }>
}) {
  const { workspace, id } = await params
  const { version } = await searchParams
  const ctx = await authContext()

  // 이 데이터셋이 가진 모든 버전(최신순) — 버전 선택기/diff 진입 노출에 사용.
  let versions: string[] = []
  try {
    const summary = datasetsSchema
      .parse(await controlPlane.listDatasets(ctx))
      .find((d) => d.id === id)
    if (summary) versions = sortSemverDesc(summary.versions)
  } catch {
    versions = []
  }

  let dataset: Dataset | undefined
  let error: string | undefined
  try {
    dataset = datasetSchema.parse(await controlPlane.getDataset(ctx, id, version ?? 'latest'))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  if (!dataset) {
    return (
      <div className="space-y-5">
        <BackLink workspace={workspace} />
        <PageHeader title="데이터셋" />
        <Callout tone="danger">데이터셋을 불러올 수 없습니다: {error}</Callout>
      </div>
    )
  }

  return (
    <div className="space-y-7">
      <div className="space-y-3">
        <BackLink workspace={workspace} />
        <PageHeader
          title={dataset.id}
          description={dataset.description ?? '하니스 무관 eval 케이스 묶음'}
          actions={
            <div className="flex items-end gap-3">
              {versions.length > 1 ? (
                <VersionSwitcher
                  id={dataset.id}
                  versions={versions}
                  current={dataset.version}
                  latest={versions[0]}
                />
              ) : (
                <Badge tone="neutral">v{dataset.version} (latest)</Badge>
              )}
              {versions.length > 1 && (
                <Link
                  href={`/${workspace}/datasets/${encodeURIComponent(dataset.id)}/diff`}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg border bg-secondary/40 px-3 text-[13px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
                >
                  <GitCompare className="size-3.5" />
                  버전 비교
                </Link>
              )}
            </div>
          }
        />
      </div>

      <Card className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
        <Prop label="id" value={dataset.id} />
        <Prop label="version" value={dataset.version} />
        <Prop label="cases" value={String(dataset.cases.length)} />
        <Prop label="tags" value={dataset.tags.length ? dataset.tags.join(', ') : '—'} />
      </Card>

      <section className="space-y-2.5">
        <SectionHeader title={`케이스 (${dataset.cases.length})`} />
        {dataset.cases.length === 0 ? (
          <EmptyState title="케이스가 없습니다." />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH className="w-[180px]">case</TH>
                <TH>task</TH>
                <TH className="text-right">env · graders</TH>
              </tr>
            </THead>
            <TBody>
              {dataset.cases.map((c) => (
                <TR key={c.id}>
                  <TD className="font-mono text-[12px] text-foreground">{c.id}</TD>
                  <TD className="text-[13px] text-muted-foreground">{c.task}</TD>
                  <TD className="text-right">
                    <span className="inline-flex flex-wrap justify-end gap-1">
                      {c.env?.kind && (
                        <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground ring-1 ring-inset ring-border">
                          {c.env.kind}
                        </code>
                      )}
                      {c.graders.map((g) => (
                        <code
                          key={g.id}
                          className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground ring-1 ring-inset ring-border"
                        >
                          {g.id}
                        </code>
                      ))}
                    </span>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </section>
    </div>
  )
}
