import Link from 'next/link'

import { runtimesSchema } from '@/entities/runtime'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Badge } from '@/shared/ui/badge'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// 런타임 목록 — 평가가 도는 실행 인프라(소유 + 공용 _shared). 사이드바에는 없고(엔진 부품) URL·예약 카드에서 진입.
export default async function RuntimesPage({
  params,
}: {
  params: Promise<{ workspace: string }>
}) {
  const { workspace } = await params
  const { ctx } = await currentPrincipal()
  let error: string | undefined
  let runtimes = runtimesSchema.parse([])
  try {
    runtimes = runtimesSchema.parse(await controlPlane.listRuntimes(ctx))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="런타임"
        description={`${runtimes.length}개 · 평가가 도는 실행 인프라 (local · docker · nomad · k8s · topology)`}
      />
      {error ? (
        <Callout tone="danger">컨트롤플레인 연결 실패: {error}</Callout>
      ) : runtimes.length === 0 ? (
        <EmptyState
          title="런타임이 없습니다."
          hint="이 워크스페이스가 볼 수 있는 런타임(소유 + 공용 _shared)이 없습니다."
        />
      ) : (
        <div className="space-y-2">
          {runtimes.map((r) => (
            <Link
              key={r.id}
              href={`/${workspace}/runtimes/${encodeURIComponent(r.id)}`}
              className="flex items-center justify-between gap-3 rounded-lg border bg-card p-3.5 shadow-raise transition-colors hover:border-border-strong hover:bg-elevated"
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-[14px] font-[510]">{r.id}</span>
                <Badge tone={r.owner === '_shared' ? 'info' : 'neutral'}>
                  {r.owner === '_shared' ? '공용' : '워크스페이스'}
                </Badge>
              </div>
              <span className="text-[12px] text-muted-foreground">{r.versions.length}개 버전</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
