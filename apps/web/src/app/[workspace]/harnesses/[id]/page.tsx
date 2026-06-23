import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'

import { HarnessDetail } from '@/features/inspect-harness'
import {
  harnessSpecSchema,
  harnessVersionsSchema,
  type HarnessKind,
  type HarnessSpec,
} from '@/entities/harness'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
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
  const ctx = await authContext()

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
            <div className="flex items-center gap-2">
              <Badge tone={KIND_TONE[spec.kind]}>{spec.kind}</Badge>
              <Badge tone="neutral">
                v{active}
                {active === versions[versions.length - 1] ? ' · latest' : ''}
              </Badge>
            </div>
          }
        />
      </div>

      {versions.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[11px] font-[510] uppercase tracking-wide text-faint">
            버전
          </span>
          {versions.map((ver) => {
            const isActive = ver === active
            return (
              <Link
                key={ver}
                href={`/${workspace}/harnesses/${encodeURIComponent(id)}?v=${encodeURIComponent(ver)}`}
                className={cn(
                  'rounded-md border px-2 py-0.5 font-mono text-[12px] transition-colors',
                  isActive
                    ? 'border-primary/40 bg-primary/12 text-[var(--color-accent-foreground)]'
                    : 'border-border bg-card text-muted-foreground hover:border-border-strong hover:text-foreground'
                )}
              >
                {ver}
              </Link>
            )
          })}
        </div>
      )}

      <HarnessDetail spec={spec} />
    </div>
  )
}
