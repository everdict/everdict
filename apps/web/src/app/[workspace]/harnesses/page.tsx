import Link from 'next/link'
import { Boxes, ChevronRight } from 'lucide-react'

import { harnessesSchema } from '@/entities/harness'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Badge } from '@/shared/ui/badge'
import { buttonVariants } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

export default async function HarnessesPage({
  params,
}: {
  params: Promise<{ workspace: string }>
}) {
  const { workspace } = await params
  const { principal, ctx } = await currentPrincipal()
  let error: string | undefined
  let harnesses = harnessesSchema.parse([])
  try {
    harnesses = harnessesSchema.parse(await controlPlane.listHarnesses(ctx))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="하니스"
        description={`${harnesses.length}건 · 이 워크스페이스가 등록한 하니스 + 공유(first-party)`}
        actions={
          can(principal?.roles, 'harnesses:register') ? (
            <Link href={`/${workspace}/harnesses/new`} className={buttonVariants({ size: 'sm' })}>
              하니스 등록
            </Link>
          ) : null
        }
      />
      {error ? (
        <Callout tone="danger">컨트롤플레인 연결 실패: {error}</Callout>
      ) : harnesses.length === 0 ? (
        <EmptyState
          icon={<Boxes />}
          title="등록된 하니스가 없습니다."
          hint="API 키로 POST /harnesses 하거나, 파일 SSOT(examples/harnesses)를 _shared 로 로드하세요."
        />
      ) : (
        <div className="space-y-2">
          {harnesses.map((h) => {
            const owned = h.owner === principal?.workspace
            return (
              <Link
                key={h.id}
                href={`/${workspace}/harnesses/${encodeURIComponent(h.id)}`}
                className="group flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-3.5 shadow-raise transition-colors hover:border-border-strong hover:bg-elevated"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span className="grid size-8 shrink-0 place-items-center rounded-md bg-elevated text-muted-foreground ring-1 ring-inset ring-border transition-colors group-hover:text-foreground">
                    <Boxes className="size-[18px]" strokeWidth={1.75} />
                  </span>
                  <div className="min-w-0 space-y-1.5">
                    <div className="truncate text-[13px] font-[560] text-foreground">{h.id}</div>
                    <div className="flex flex-wrap gap-1">
                      {h.versions.map((v) => (
                        <code
                          key={v}
                          className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground ring-1 ring-inset ring-border"
                        >
                          {v}
                        </code>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge tone={owned ? 'success' : 'neutral'}>{owned ? 'owned' : 'shared'}</Badge>
                  <ChevronRight className="size-4 text-faint transition-all group-hover:translate-x-0.5 group-hover:text-muted-foreground" />
                </div>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
