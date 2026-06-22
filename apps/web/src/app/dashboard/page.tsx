import Link from 'next/link'
import { Boxes, ChevronRight } from 'lucide-react'

import { RunsTable } from '@/widgets/runs-table'
import { ScorecardSummary } from '@/widgets/scorecard-summary'
import { harnessesSchema } from '@/entities/harness'
import { runsSchema } from '@/entities/run'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'
import { SectionHeader } from '@/shared/ui/section-header'

export const dynamic = 'force-dynamic'

function ViewAll({ href }: { href: string }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
    >
      전체 보기
      <ChevronRight className="size-3.5" />
    </Link>
  )
}

export default async function OverviewPage() {
  const ctx = await authContext()
  let error: string | undefined
  let runs = runsSchema.parse([])
  let harnesses = harnessesSchema.parse([])
  try {
    const [r, h] = await Promise.all([controlPlane.listRuns(ctx), controlPlane.listHarnesses(ctx)])
    runs = runsSchema.parse(r)
    harnesses = harnessesSchema.parse(h)
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  return (
    <div className="space-y-7">
      <PageHeader title="개요" description="이 워크스페이스의 평가 현황" />

      {error ? (
        <Callout tone="danger" hint="`CONTROL_PLANE_URL` 과 `assay-api` 가동 여부를 확인하세요.">
          컨트롤플레인에 연결할 수 없습니다: {error}
        </Callout>
      ) : (
        <ScorecardSummary runs={runs} />
      )}

      <section className="space-y-2.5">
        <SectionHeader title="최근 Runs" action={<ViewAll href="/dashboard/runs" />} />
        <RunsTable runs={runs} limit={5} />
      </section>

      <section className="space-y-2.5">
        <SectionHeader title="하니스" action={<ViewAll href="/dashboard/harnesses" />} />
        {harnesses.length === 0 ? (
          <EmptyState
            icon={<Boxes />}
            title="등록된 하니스가 없습니다."
            hint="API(POST /harnesses) 또는 파일 SSOT 로 등록하세요."
          />
        ) : (
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            {harnesses.slice(0, 6).map((h) => (
              <Link
                key={h.id}
                href="/dashboard/harnesses"
                className="group flex items-start gap-3 rounded-lg border bg-card p-3.5 shadow-raise transition-colors hover:border-border-strong hover:bg-elevated"
              >
                <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md bg-elevated text-muted-foreground ring-1 ring-inset ring-border group-hover:text-foreground">
                  <Boxes className="size-[18px]" strokeWidth={1.75} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-[560] text-foreground">
                    {h.id}
                  </span>
                  <span className="mt-1 flex flex-wrap gap-1">
                    {h.versions.slice(0, 4).map((v) => (
                      <span
                        key={v}
                        className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground ring-1 ring-inset ring-border"
                      >
                        {v}
                      </span>
                    ))}
                    {h.versions.length > 4 && (
                      <span className="px-1 py-0.5 text-[10.5px] text-faint">
                        +{h.versions.length - 4}
                      </span>
                    )}
                  </span>
                </span>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
