import Link from 'next/link'
import { Server } from 'lucide-react'

import { RunnersManager } from '@/features/manage-runners'
import { runnersResponseSchema, type RunnerMeta } from '@/entities/runner'
import { runtimesSchema } from '@/entities/runtime'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Badge } from '@/shared/ui/badge'
import { buttonVariants } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// 섹션 타이틀 + 한 줄 설명 — 실행 대상 두 축(등록 인프라/내 머신)을 구분.
function Section({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <section className="space-y-2.5">
      <div className="space-y-1">
        <h2 className="text-[14px] font-[560] tracking-[-0.01em] text-foreground">{title}</h2>
        <p className="text-[12px] text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  )
}

// 런타임 — "평가가 어디서 실행되는가"의 단일 표면.
// ① 등록 인프라(push: 컨트롤플레인이 접속하는 docker/nomad/k8s/topology — 워크스페이스 소유)
// ② 내 머신(pull: 셀프호스티드 러너 — 개인 소유 디바이스가 잡을 lease 로 당겨감).
export default async function RuntimesPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace } = await params
  const { ctx } = await currentPrincipal()
  let error: string | undefined
  let runtimes = runtimesSchema.parse([])
  try {
    runtimes = runtimesSchema.parse(await controlPlane.listRuntimes(ctx))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  // 셀프호스티드 러너 — 개인 소유라 역할 게이트 없이 본인(subject)의 러너만 조회. 실패해도 페이지는 렌더(빈 목록).
  let runners: RunnerMeta[] = []
  try {
    runners = runnersResponseSchema.parse(await controlPlane.listRunners(ctx)).runners
  } catch {
    // 컨트롤플레인 러너 서비스 미설정/실패 — 빈 목록으로 폴백.
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title="런타임"
        description="평가가 실행되는 곳 — 등록한 인프라와 내 머신(셀프호스티드 러너)을 한곳에서 관리해요."
        actions={
          <Link href={`/${workspace}/runtimes/new`} className={buttonVariants({ size: 'sm' })}>
            런타임 등록
          </Link>
        }
      />

      <Section
        title={`등록 인프라 (${runtimes.length})`}
        description="워크스페이스가 등록한 docker/nomad/k8s/topology — 컨트롤플레인이 접속해 평가를 배치해요."
      >
        {error ? (
          <Callout tone="danger">서버에 연결하지 못했어요: {error}</Callout>
        ) : runtimes.length === 0 ? (
          <EmptyState
            icon={<Server strokeWidth={1.75} />}
            title="아직 등록한 인프라가 없어요."
            hint="'런타임 등록'으로 워크스페이스 인프라를 연결하거나, 아래에서 내 머신을 러너로 연결해보세요."
          />
        ) : (
          <div className="space-y-2">
            {runtimes.map((r) => (
              <Link
                key={r.id}
                href={`/${workspace}/runtimes/${encodeURIComponent(r.id)}`}
                className="flex h-[52px] items-center gap-3 rounded-lg border bg-card px-3.5 shadow-raise transition-colors hover:border-border-strong hover:bg-elevated"
              >
                <Server className="size-4 shrink-0 text-[#6ec6a8]" />
                <span className="min-w-0 flex-1 truncate font-mono text-[13px] font-[510]">
                  {r.id}
                </span>
                <Badge tone={r.owner === '_shared' ? 'info' : 'neutral'}>
                  {r.owner === '_shared' ? '공용' : '워크스페이스'}
                </Badge>
                <span className="w-[76px] text-right text-[12px] text-muted-foreground">
                  {r.versions.length}개 버전
                </span>
              </Link>
            ))}
          </div>
        )}
      </Section>

      <Section
        title="내 머신 연결 (셀프호스티드 러너)"
        description="내 컴퓨터가 잡을 당겨가 실행해요(방화벽 뒤도 OK) — 개인 소유·개인 결제라 워크스페이스 예산을 쓰지 않아요."
      >
        <RunnersManager runners={runners} downloadHref={`/${workspace}/download`} />
      </Section>
    </div>
  )
}
