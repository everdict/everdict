import Link from 'next/link'
import { Server } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

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
  const t = await getTranslations('runtimesPage')
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
        title={t('title')}
        description={t('description')}
        actions={
          <Link href={`/${workspace}/runtimes/new`} className={buttonVariants({ size: 'sm' })}>
            {t('register')}
          </Link>
        }
      />

      <Section
        title={t('registeredInfra', { count: runtimes.length })}
        description={t('registeredInfraDescription')}
      >
        {error ? (
          <Callout tone="danger">{t('connectError', { error })}</Callout>
        ) : runtimes.length === 0 ? (
          <EmptyState
            icon={<Server strokeWidth={1.75} />}
            title={t('emptyInfraTitle')}
            hint={t('emptyInfraHint')}
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
                  {r.owner === '_shared' ? t('sharedBadge') : t('workspaceBadge')}
                </Badge>
                <span className="w-[76px] text-right text-[12px] text-muted-foreground">
                  {t('versionCount', { count: r.versions.length })}
                </span>
              </Link>
            ))}
          </div>
        )}
      </Section>

      <Section title={t('myMachine')} description={t('myMachineDescription')}>
        <RunnersManager runners={runners} downloadHref={`/${workspace}/download`} />
      </Section>
    </div>
  )
}
