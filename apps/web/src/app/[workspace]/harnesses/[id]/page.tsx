import type { ReactNode } from 'react'
import Link from 'next/link'
import { ChevronLeft, FileText, GitBranchPlus, Lock } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import { CommentsSection } from '@/features/discuss'
import { HarnessVersionSwitcher } from '@/features/harness-versions'
import { HarnessDetail, RawConfigDisclosure } from '@/features/inspect-harness'
import { CiLinkPanel } from '@/features/manage-ci-links'
import { HarnessSinkSelect } from '@/features/manage-trace-sink'
import { VersionTagsEditor } from '@/features/version-tags'
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
import { imageRegistriesResponseSchema } from '@/entities/image-registry'
import { membersSchema } from '@/entities/member'
import { traceSinksResponseSchema, type TraceSinksResponse } from '@/entities/trace-sink'
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

function BackLink({ workspace, label }: { workspace: string; label: string }) {
  return (
    <Link
      href={`/${workspace}/harnesses`}
      className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
    >
      <ChevronLeft className="size-3.5" />
      {label}
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
  const t = await getTranslations('harnessesPage')

  let versions: string[] = []
  let versionTags: Record<string, string[]> = {}
  let spec: HarnessSpec | undefined
  let error: string | undefined
  let active: string | undefined
  try {
    const detail = harnessVersionsSchema.parse(await controlPlane.getHarness(ctx, id))
    versions = detail.versions
    versionTags = detail.versionTags ?? {}
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

  // 버전 태그 편집 가능 여부 — 등록과 동일 게이트(harnesses:register) + 이 워크스페이스 소유일 때만
  // (_shared/first-party 는 컨트롤플레인이 404 로 거부하므로 편집 UI 자체를 숨긴다).
  const canTagVersions =
    can(principal?.roles, 'harnesses:register') &&
    entry !== undefined &&
    entry.owner === currentWorkspace

  // 워크스페이스 이미지 레지스트리 좌표(viewer+, 복수) — 서비스/커맨드 이미지의 출처 분류 배지용
  // (어느 레지스트리든 매칭되면 workspace). 실패해도 상세는 렌더.
  const imageRegistries = await controlPlane
    .listImageRegistries(ctx)
    .then((r) => imageRegistriesResponseSchema.parse(r).registries)
    .catch(() => [])
  const registryCoords = imageRegistries.map((r) => ({
    host: r.host,
    ...(r.namespace ? { namespace: r.namespace } : {}),
  }))

  // 트레이스 싱크(복수) + 이 하니스의 선택(assignment) — 채점 상세를 어느 관측 플랫폼에 적재할지.
  // 실패해도 상세는 렌더(선택 행만 숨김).
  const traceSinks: TraceSinksResponse = await controlPlane
    .listTraceSinks(ctx)
    .then((r) => traceSinksResponseSchema.parse(r))
    .catch(() => ({ sinks: [], assignments: {} }))
  const assignedSink: string | undefined = traceSinks.assignments[id]

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
        <BackLink workspace={workspace} label={t('backToList')} />
        <PageHeader title={id} />
        <Callout tone="danger">{t('loadError', { error: error ?? t('unknownError') })}</Callout>
      </div>
    )
  }

  // kind 별 한 줄 요약 — 헤더 설명.
  const summary =
    spec.kind === 'service'
      ? t('summaryService', {
          svc: spec.services?.length ?? 0,
          dep: spec.dependencies?.length ?? 0,
          target: spec.target ? t('summaryTargetSuffix') : '',
        })
      : spec.kind === 'command'
        ? t('summaryCommand', {
            tool: spec.command?.split(' ')[0] ?? 'cli',
            setup: spec.setup?.length ?? 0,
          })
        : t('summaryProcess')

  return (
    <div className="space-y-7">
      <div className="space-y-3">
        <BackLink workspace={workspace} label={t('backToList')} />
        <PageHeader
          title={spec.id}
          description={summary}
          actions={
            <div className="flex flex-wrap items-center justify-end gap-2">
              {versions.length > 1 ? (
                <HarnessVersionSwitcher
                  id={id}
                  versions={versions}
                  current={active ?? ''}
                  latest={versions[versions.length - 1]}
                  versionTags={versionTags}
                />
              ) : (
                <Badge tone="neutral">v{active} · latest</Badge>
              )}
              <Link
                href={`/${workspace}/harnesses/${encodeURIComponent(id)}/new-version?v=${encodeURIComponent(active ?? '')}`}
                className={buttonVariants({ variant: 'secondary', size: 'sm' })}
              >
                <GitBranchPlus className="size-3.5" />
                {t('newVersion')}
              </Link>
            </div>
          }
        />
      </div>

      {/* 이 버전의 변경 내역(description) — 배포 때 입력한 자유 메모. 없으면 섹션 자체를 숨긴다(빈 섹션 노출 금지). */}
      {versionNote && (
        <Card className="p-5">
          <div className="mb-2 flex items-center gap-1.5 text-[11px] font-[510] uppercase tracking-wide text-faint">
            <FileText className="size-3.5" />
            {t('versionChangeNote')}
          </div>
          <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-foreground">
            {versionNote}
          </p>
        </Card>
      )}

      {/* 메타 — 라벨(왼)·값(오) 항목을 반응형 그리드로. 화면이 넓을수록 열을 늘려(2→3→4) 넉넉히 펼친다. */}
      <Card className="grid grid-cols-1 gap-x-10 gap-y-4 p-5 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
        <MetaItem label={t('metaKind')}>
          <Badge tone={KIND_TONE[spec.kind]}>{spec.kind}</Badge>
        </MetaItem>
        {entry?.category && <MetaItem label={t('metaCategory')}>{entry.category}</MetaItem>}
        <MetaItem label={t('metaVersion')}>
          <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[11.5px] text-secondary-foreground">
            v{active}
          </code>
          {active === versions[versions.length - 1] && (
            <span className="text-[11px] text-faint">latest</span>
          )}
          <span className="text-[11px] text-faint">
            {t('versionCountMeta', { count: versions.length || 1 })}
          </span>
        </MetaItem>
        {/* 이 버전의 태그(자유 라벨) — 편집 불가 + 태그 없음이면 행 자체를 숨긴다(빈 섹션 노출 금지).
            _shared(first-party) 하니스는 태깅 불가(레지스트리가 404) → 소유 워크스페이스일 때만 편집 노출. */}
        {active && (canTagVersions || (versionTags[active] ?? []).length > 0) && (
          <MetaItem label={t('metaTags')}>
            <VersionTagsEditor
              entity="harness"
              id={id}
              version={active}
              tags={versionTags[active] ?? []}
              canEdit={canTagVersions}
            />
          </MetaItem>
        )}
        {entry?.createdAt && (
          <MetaItem
            label={t('metaCreated')}
            title={t('createdTitle', { time: fmtDateTimeFull(entry.createdAt) })}
          >
            {fmtDateTime(entry.createdAt)}
          </MetaItem>
        )}
        {entry?.updatedAt && entry.updatedAt !== entry.createdAt && (
          <MetaItem
            label={t('metaUpdated')}
            title={t('updatedTitle', { time: fmtDateTimeFull(entry.updatedAt) })}
          >
            {fmtDateTime(entry.updatedAt)}
          </MetaItem>
        )}
        <MetaItem label={t('metaAuthor')}>
          {author.known && <Avatar name={author.name} url={author.avatarUrl} size="sm" />}
          <span>{author.name}</span>
        </MetaItem>
        {/* 하니스별 트레이스 싱크 선택 — 워크스페이스에 싱크가 없고 선택도 없으면 행 자체를 숨긴다(빈 섹션 노출 금지). */}
        {(traceSinks.sinks.length > 0 || assignedSink !== undefined) && (
          <MetaItem label={t('metaTraceSink')}>
            <HarnessSinkSelect
              harnessId={id}
              sinks={traceSinks.sinks.map((s) => ({ name: s.name, kind: s.kind }))}
              {...(assignedSink !== undefined ? { current: assignedSink } : {})}
              canAssign={can(principal?.roles, 'harnesses:register')}
            />
          </MetaItem>
        )}
        {entry?.private && (
          <MetaItem label={t('metaVisibility')}>
            <span className="inline-flex items-center gap-1 text-[var(--color-warning)]">
              <Lock className="size-3" /> {t('visibilityPrivate')}
            </span>
          </MetaItem>
        )}
      </Card>

      {/* 구성 — 이 하니스가 실제로 실행되는 최종 설정을 깔끔한 값 뷰로. 원본(pins/overrides)·JSON 은 접이식. */}
      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-[15px] font-[560] tracking-[-0.01em] text-foreground">
            {t('configHeading')}
          </h2>
          <p className="text-[12px] text-muted-foreground">{t('configDescription')}</p>
        </div>
        <HarnessDetail
          spec={spec}
          {...(registryCoords.length > 0 ? { registry: registryCoords } : {})}
        />
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
        title={t('discussTitle')}
      />
    </div>
  )
}
