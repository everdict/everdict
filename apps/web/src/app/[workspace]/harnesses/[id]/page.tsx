import Link from 'next/link'
import { ChevronLeft, GitBranchPlus } from 'lucide-react'

import { HarnessVersionSwitcher } from '@/features/harness-versions'
import { ConfigPanel, HarnessDetail } from '@/features/inspect-harness'
import { CiLinkPanel } from '@/features/manage-ci-links'
import { ciLinksResponseSchema, type CiLink } from '@/entities/ci-link'
import { connectionsResponseSchema, type ConnectionMeta } from '@/entities/connection'
import { datasetsSchema } from '@/entities/dataset'
import {
  harnessInstanceSpecSchema,
  harnessSpecSchema,
  harnessTemplateSpecSchema,
  harnessVersionsSchema,
  type HarnessInstanceSpec,
  type HarnessKind,
  type HarnessSpec,
  type HarnessTemplateSpec,
} from '@/entities/harness'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Badge } from '@/shared/ui/badge'
import { buttonVariants } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

const KIND_TONE: Record<HarnessKind, 'info' | 'warning' | 'neutral'> = {
  service: 'info',
  command: 'warning',
  process: 'neutral',
}

// kind 별 한 줄 요약 — 헤더 설명.
function summarize(spec: HarnessSpec): string {
  if (spec.kind === 'service') {
    const svc = spec.services?.length ?? 0
    const dep = spec.dependencies?.length ?? 0
    const target = spec.target ? ' · 타깃 환경' : ''
    return `service 토폴로지 · 서비스 ${svc} · 스토어 ${dep}${target}`
  }
  if (spec.kind === 'command') {
    const tool = spec.command?.split(' ')[0] ?? 'cli'
    const setup = spec.setup?.length ?? 0
    return `command(선언형 CLI) · ${tool} · 설치 ${setup}`
  }
  return '단일 샌드박스 프로세스 (Claude Code · Codex)'
}

function BackLink({ workspace }: { workspace: string }) {
  return (
    <Link
      href={`/${workspace}/harnesses`}
      className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
    >
      <ChevronLeft className="size-3.5" />
      하니스
    </Link>
  )
}

export default async function HarnessDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; id: string }>
  searchParams: Promise<{ v?: string }>
}) {
  const { workspace, id } = await params
  const { v } = await searchParams
  const { principal, ctx } = await currentPrincipal()

  let versions: string[] = []
  let spec: HarnessSpec | undefined
  let error: string | undefined
  let active: string | undefined
  try {
    const detail = harnessVersionsSchema.parse(await controlPlane.getHarness(ctx, id))
    versions = detail.versions
    const requested = typeof v === 'string' && versions.includes(v) ? v : undefined
    active = requested ?? versions[versions.length - 1] // latest = semver/등록순 최상위
    if (active) spec = harnessSpecSchema.parse(await controlPlane.getHarnessSpec(ctx, id, active))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  // 원본 구성(템플릿 참조 + pins) — 새 버전 편집의 출발점. resolve 와 별개라 실패해도 상세는 계속 표시.
  let config: { instance: HarnessInstanceSpec; template: HarnessTemplateSpec } | undefined
  if (active && spec) {
    try {
      const instance = harnessInstanceSpecSchema.parse(
        await controlPlane.getHarnessInstance(ctx, id, active)
      )
      const template = harnessTemplateSpecSchema.parse(
        await controlPlane.getHarnessTemplateSpec(
          ctx,
          instance.template.id,
          instance.template.version
        )
      )
      config = { instance, template }
    } catch {
      config = undefined
    }
  }

  // CI 연동(레포 링크) — 이 하니스에 매칭된 링크 + 레포 picker 에 필요한 내 GitHub 연결 + 데이터셋 후보.
  // 셋 다 실패해도 상세는 계속 렌더(패널만 빈 상태). 저장/해제는 admin(settings:write) — 컨트롤플레인이 최종 강제.
  let ciLinks: CiLink[] = []
  let ciConnections: ConnectionMeta[] = []
  let ciDatasets: string[] = []
  if (spec) {
    try {
      ciLinks = ciLinksResponseSchema
        .parse(await controlPlane.listCiLinks(ctx))
        .links.filter((l) => l.harness === id)
    } catch {
      ciLinks = []
    }
    try {
      ciConnections = connectionsResponseSchema
        .parse(await controlPlane.listConnections(ctx))
        .connections.filter((c) => c.provider === 'github' || c.provider === 'github-enterprise')
    } catch {
      ciConnections = []
    }
    try {
      ciDatasets = datasetsSchema.parse(await controlPlane.listDatasets(ctx)).map((d) => d.id)
    } catch {
      ciDatasets = []
    }
  }

  if (!spec) {
    return (
      <div className="space-y-5">
        <BackLink workspace={workspace} />
        <PageHeader title={id} />
        <Callout tone="danger">하니스를 불러올 수 없습니다: {error ?? '알 수 없는 오류'}</Callout>
      </div>
    )
  }

  return (
    <div className="space-y-7">
      <div className="space-y-3">
        <BackLink workspace={workspace} />
        <PageHeader
          title={spec.id}
          description={summarize(spec)}
          actions={
            <div className="flex items-end gap-2">
              <Badge tone={KIND_TONE[spec.kind]}>{spec.kind}</Badge>
              {versions.length > 1 ? (
                <HarnessVersionSwitcher
                  id={id}
                  versions={versions}
                  current={active ?? ''}
                  latest={versions[versions.length - 1]}
                />
              ) : (
                <Badge tone="neutral">v{active} · latest</Badge>
              )}
              <Link
                href={`/${workspace}/harnesses/${encodeURIComponent(id)}/new-version?v=${encodeURIComponent(active ?? '')}`}
                className={buttonVariants({ variant: 'secondary', size: 'sm' })}
              >
                <GitBranchPlus className="size-3.5" />새 버전 만들기
              </Link>
            </div>
          }
        />
      </div>

      {config && (
        <section className="space-y-4">
          <div className="space-y-1">
            <h2 className="text-[15px] font-[560] tracking-[-0.01em] text-foreground">구성</h2>
            <p className="text-[12px] text-muted-foreground">
              이 버전이 어떤 템플릿(대분류) 위에서 슬롯마다 핀한 값 — 새 버전 만들기의 출발점입니다.
            </p>
          </div>
          <ConfigPanel instance={config.instance} template={config.template} />
        </section>
      )}

      <section className="space-y-4">
        <h2 className="text-[15px] font-[560] tracking-[-0.01em] text-foreground">Resolved 스펙</h2>
        <HarnessDetail spec={spec} />
      </section>

      <CiLinkPanel
        harnessId={spec.id}
        kind={spec.kind}
        serviceNames={spec.kind === 'service' ? (spec.services ?? []).map((s) => s.name) : []}
        datasets={ciDatasets}
        connections={ciConnections}
        initialLinks={ciLinks}
        canWrite={can(principal?.roles, 'settings:write')}
        workspace={workspace}
      />
    </div>
  )
}
