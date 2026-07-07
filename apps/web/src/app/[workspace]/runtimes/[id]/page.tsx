import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ChevronLeft } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import { CommentsSection } from '@/features/discuss'
import { VersionTagsEditor } from '@/features/version-tags'
import {
  runtimeSpecSchema,
  runtimesSchema,
  type RuntimeSpec,
  type RuntimeSummary,
} from '@/entities/runtime'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { sortSemverDesc } from '@/shared/lib/semver'
import { Badge } from '@/shared/ui/badge'
import { Callout } from '@/shared/ui/callout'
import { Card } from '@/shared/ui/card'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// RuntimeSpec 의 kind별 설정 필드 → 표시용 라벨/값 행(값 있는 것만).
function specRows(
  spec: RuntimeSpec,
  labels: {
    addr: string
    datacenters: string
    nomadRuntime: string
    k8sContext: string
    image: string
    namespace: string
    tags: string
  }
): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = []
  const add = (label: string, v: string | string[] | undefined) => {
    if (v === undefined) return
    if (Array.isArray(v)) {
      if (v.length > 0) rows.push({ label, value: v.join(', ') })
    } else {
      rows.push({ label, value: v })
    }
  }
  add(labels.addr, spec.addr)
  add(labels.datacenters, spec.datacenters)
  add(labels.nomadRuntime, spec.runtime)
  add(labels.k8sContext, spec.context)
  add('RuntimeClass', spec.runtimeClass)
  add(labels.image, spec.image)
  add(labels.namespace, spec.namespace)
  add(labels.tags, spec.tags)
  return rows
}

export default async function RuntimeDetailPage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>
}) {
  const { workspace, id } = await params
  const t = await getTranslations('runtimesPage')
  const { principal, ctx } = await currentPrincipal()

  // 목록에서 이 런타임의 요약(버전/소유자) 확보 — 없거나 연결 실패면 목록으로.
  let summary: RuntimeSummary | undefined
  try {
    summary = runtimesSchema.parse(await controlPlane.listRuntimes(ctx)).find((r) => r.id === id)
  } catch {
    summary = undefined
  }
  if (!summary) redirect(`/${workspace}/runtimes`)

  const versions = sortSemverDesc(summary.versions)
  const latest = versions[0] ?? summary.versions[0]
  let spec: RuntimeSpec | undefined
  let error: string | undefined
  try {
    spec = runtimeSpecSchema.parse(await controlPlane.getRuntime(ctx, id, latest))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  const rows = spec
    ? specRows(spec, {
        addr: t('specAddr'),
        datacenters: t('specDatacenters'),
        nomadRuntime: t('specNomadRuntime'),
        k8sContext: t('specK8sContext'),
        image: t('specImage'),
        namespace: t('specNamespace'),
        tags: t('specTags'),
      })
    : []

  // 이 버전(표시본=latest)의 태그(자유 라벨) — 등록과 동일 게이트(runtimes:write) + 소유 워크스페이스일 때만 편집.
  const currentWorkspace = principal?.workspace ?? workspace
  const canEditTags = can(principal?.roles, 'runtimes:write') && summary.owner === currentWorkspace
  const latestTags = summary.versionTags?.[latest] ?? []

  return (
    <div className="space-y-6">
      <Link
        href={`/${workspace}/runtimes`}
        className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronLeft className="size-3.5" />
        {t('title')}
      </Link>
      <PageHeader title={id} description={t('detailDescription')} />
      {error || !spec ? (
        <Callout tone="danger">{t('loadError', { detail: error ? `: ${error}` : '' })}</Callout>
      ) : (
        <Card className="space-y-4 p-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="info">{spec.kind}</Badge>
            <Badge tone={summary.owner === '_shared' ? 'info' : 'neutral'}>
              {summary.owner === '_shared' ? t('sharedBadge') : t('workspaceBadge')}
            </Badge>
            <span className="font-mono text-[12px] text-faint">v{spec.version}</span>
          </div>
          {spec.description ? (
            <p className="text-[13px] leading-relaxed text-muted-foreground">{spec.description}</p>
          ) : null}
          {rows.length > 0 ? (
            <div className="space-y-2 border-t border-border pt-4 text-[13px]">
              {rows.map((r) => (
                <div key={r.label} className="flex gap-4">
                  <span className="w-[128px] shrink-0 text-muted-foreground">{r.label}</span>
                  <span className="break-all font-mono">{r.value}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="border-t border-border pt-4 text-[12px] text-faint">
              {t('noExtraConfig')}
            </p>
          )}
          {/* 이 버전(표시본=latest)의 태그 — placement 태그(위 rows 의 '태그')와 별개인 버전 분간용 자유 라벨.
              편집 불가 + 태그 없음이면 블록 자체를 숨긴다(빈 섹션 노출 금지). */}
          {(canEditTags || latestTags.length > 0) && (
            <div className="border-t border-border pt-4">
              <p className="mb-1.5 text-[11px] font-[510] uppercase tracking-wide text-faint">
                {t('versionTags')}
              </p>
              <VersionTagsEditor
                entity="runtime"
                id={id}
                version={latest}
                tags={latestTags}
                canEdit={canEditTags}
              />
            </div>
          )}
          <div className="border-t border-border pt-4">
            <p className="mb-1.5 text-[11px] font-[510] uppercase tracking-wide text-faint">
              {t('versions')}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {versions.map((v) => (
                <code
                  key={v}
                  className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[11px] text-secondary-foreground"
                >
                  {v}
                </code>
              ))}
            </div>
          </div>
        </Card>
      )}

      <CommentsSection
        workspace={workspace}
        resourceType="runtime"
        resourceId={id}
        title={t('discuss')}
      />
    </div>
  )
}
