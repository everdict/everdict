import type { ReactNode } from 'react'
import Link from 'next/link'
import { ChevronLeft, FileText, GitBranchPlus, Lock } from 'lucide-react'

import { CommentsSection } from '@/features/discuss'
import { HarnessVersionSwitcher } from '@/features/harness-versions'
import { HarnessDetail, RawConfigDisclosure } from '@/features/inspect-harness'
import { CiLinkPanel } from '@/features/manage-ci-links'
import { ciLinksResponseSchema, type CiLink } from '@/entities/ci-link'
import { datasetsSchema } from '@/entities/dataset'
import {
  harnessesSchema,
  harnessInstanceSpecSchema,
  harnessSpecSchema,
  harnessTemplateSpecSchema,
  harnessVersionsSchema,
  type Harness,
  type HarnessInstanceSpec,
  type HarnessKind,
  type HarnessSpec,
  type HarnessTemplateSpec,
} from '@/entities/harness'
import { membersSchema } from '@/entities/member'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { fmtDateTime, fmtDateTimeFull, fmtSubject } from '@/shared/lib/format'
import { Avatar } from '@/shared/ui/avatar'
import { Badge } from '@/shared/ui/badge'
import { buttonVariants } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Card } from '@/shared/ui/card'
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
    return `여러 서비스로 구성 · 서비스 ${svc} · 스토어 ${dep}${target}`
  }
  if (spec.kind === 'command') {
    const tool = spec.command?.split(' ')[0] ?? 'cli'
    const setup = spec.setup?.length ?? 0
    return `CLI 에이전트 · ${tool} · 설치 ${setup}`
  }
  return '단일 프로세스로 실행 (Claude Code · Codex)'
}

// 메타 항목 — 구성 값 리스트(DefRow)와 동일한 라벨(왼)·값(오) 행. divided Card 안에서 반복.
function MetaItem({
  label,
  title,
  children,
}: {
  label: string
  title?: string
  children: ReactNode
}) {
  return (
    <div
      className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-4"
      {...(title ? { title } : {})}
    >
      <span className="shrink-0 text-[11px] font-[510] uppercase tracking-wide text-faint sm:w-20">
        {label}
      </span>
      <div className="flex min-w-0 flex-1 items-center gap-1.5 text-[13px] text-foreground">
        {children}
      </div>
    </div>
  )
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

  // 목록 메타(분류·등록자·시각) + 만든이 이름(members 조인) — 부가 정보라 실패해도 상세는 보인다.
  const entry: Harness | undefined = await controlPlane
    .listHarnesses(ctx)
    .then((r) => harnessesSchema.parse(r).find((h) => h.id === id))
    .catch(() => undefined)
  const members = await controlPlane
    .listMembers(ctx)
    .then((r) => membersSchema.parse(r))
    .catch(() => [])
  const currentWorkspace = principal?.workspace ?? workspace
  // 만든이 — 프로필 이름+아바타(있으면). 시드/_shared(다른 소유·createdBy 없음)는 first-party 로 표기.
  const author = (() => {
    if (!entry?.createdBy) {
      return {
        name: entry && entry.owner !== currentWorkspace ? 'first-party' : '—',
        known: false as const,
      }
    }
    const m = members.find((x) => x.subject === entry.createdBy)
    return {
      name: m?.name ?? m?.email ?? fmtSubject(entry.createdBy),
      ...(m?.avatarUrl ? { avatarUrl: m.avatarUrl } : {}),
      known: true as const,
    }
  })()

  // 원본 구성(템플릿 참조 + pins) + 이 버전의 변경 내역(description). 새 버전 편집의 출발점.
  // resolve 와 별개라 실패해도 상세는 계속 표시. description 은 인스턴스에만 있어(템플릿 fetch 성패와 무관) 따로 뽑아둔다.
  let config: { instance: HarnessInstanceSpec; template: HarnessTemplateSpec } | undefined
  let versionNote: string | undefined
  if (active && spec) {
    const instance = await controlPlane
      .getHarnessInstance(ctx, id, active)
      .then((r) => harnessInstanceSpecSchema.parse(r))
      .catch(() => undefined)
    const note = instance?.description?.trim()
    versionNote = note ? note : undefined
    if (instance) {
      const template = await controlPlane
        .getHarnessTemplateSpec(ctx, instance.template.id, instance.template.version)
        .then((r) => harnessTemplateSpecSchema.parse(r))
        .catch(() => undefined)
      if (template) config = { instance, template }
    }
  }

  // CI 연동(레포 링크) — 이 하니스에 매칭된 링크 + 레포 picker 에 필요한 내 GitHub 연결 + 데이터셋 후보.
  // 셋 다 실패해도 상세는 계속 렌더(패널만 빈 상태). 저장/해제는 admin(settings:write) — 컨트롤플레인이 최종 강제.
  let ciLinks: CiLink[] = []
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
        <Callout tone="danger">하니스를 불러오지 못했어요: {error ?? '알 수 없는 오류'}</Callout>
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
            <div className="flex flex-wrap items-center justify-end gap-2">
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

      {/* 이 버전의 변경 내역(description) — 배포 때 입력한 자유 메모. 없으면 섹션 자체를 숨긴다(빈 섹션 노출 금지). */}
      {versionNote && (
        <Card className="p-5">
          <div className="mb-2 flex items-center gap-1.5 text-[11px] font-[510] uppercase tracking-wide text-faint">
            <FileText className="size-3.5" />이 버전의 변경 내역
          </div>
          <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-foreground">
            {versionNote}
          </p>
        </Card>
      )}

      {/* 메타 — 라벨(왼)·값(오) 항목을 반응형 그리드로. 화면이 넓을수록 열을 늘려(2→3→4) 넉넉히 펼친다. */}
      <Card className="grid grid-cols-1 gap-x-10 gap-y-4 p-5 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
        <MetaItem label="종류">
          <Badge tone={KIND_TONE[spec.kind]}>{spec.kind}</Badge>
        </MetaItem>
        {entry?.category && <MetaItem label="분류">{entry.category}</MetaItem>}
        <MetaItem label="버전">
          <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[11.5px] text-secondary-foreground">
            v{active}
          </code>
          {active === versions[versions.length - 1] && (
            <span className="text-[11px] text-faint">latest</span>
          )}
          <span className="text-[11px] text-faint">· {versions.length || 1}개</span>
        </MetaItem>
        {entry?.createdAt && (
          <MetaItem label="생성" title={`생성 ${fmtDateTimeFull(entry.createdAt)}`}>
            {fmtDateTime(entry.createdAt)}
          </MetaItem>
        )}
        {entry?.updatedAt && entry.updatedAt !== entry.createdAt && (
          <MetaItem label="수정" title={`수정 ${fmtDateTimeFull(entry.updatedAt)}`}>
            {fmtDateTime(entry.updatedAt)}
          </MetaItem>
        )}
        <MetaItem label="만든이">
          {author.known && <Avatar name={author.name} url={author.avatarUrl} size="sm" />}
          <span>{author.name}</span>
        </MetaItem>
        {entry?.private && (
          <MetaItem label="공개 범위">
            <span className="inline-flex items-center gap-1 text-[var(--color-warning)]">
              <Lock className="size-3" /> 비공개
            </span>
          </MetaItem>
        )}
      </Card>

      {/* 구성 — 이 하니스가 실제로 실행되는 최종 설정을 깔끔한 값 뷰로. 원본(pins/overrides)·JSON 은 접이식. */}
      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-[15px] font-[560] tracking-[-0.01em] text-foreground">구성</h2>
          <p className="text-[12px] text-muted-foreground">
            이 하니스가 실제로 실행되는 설정이에요.
          </p>
        </div>
        <HarnessDetail spec={spec} />
        <RawConfigDisclosure {...(config ? { config } : {})} spec={spec} />
      </section>

      <CiLinkPanel
        harnessId={spec.id}
        kind={spec.kind}
        serviceNames={spec.kind === 'service' ? (spec.services ?? []).map((s) => s.name) : []}
        datasets={ciDatasets}
        initialLinks={ciLinks}
        canWrite={can(principal?.roles, 'settings:write')}
        workspace={workspace}
      />

      <CommentsSection
        workspace={workspace}
        resourceType="harness"
        resourceId={spec.id}
        title="논의"
      />
    </div>
  )
}
