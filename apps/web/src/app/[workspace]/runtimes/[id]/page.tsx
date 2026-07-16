import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ChevronLeft, Pencil } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import { CommentsSection } from '@/features/discuss'
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
import { buttonVariants } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Card } from '@/shared/ui/card'
import { PageHeader } from '@/shared/ui/page-header'

import { RuntimeClusterStatus } from './runtime-cluster-status'
import { RuntimeHealthActions } from './runtime-health-actions'

export const dynamic = 'force-dynamic'

// RuntimeSpec's config fields → display label/value rows (only those with a value). Secrets are shown by NAME (a reference, not the value).
function specRows(
  spec: RuntimeSpec,
  labels: {
    addr: string
    server: string
    k8sContext: string
    image: string
    namespace: string
    nomadRuntime: string
    authSecret: string
    kubeconfigSecret: string
    maxConcurrent: string
    memoryBudget: string
    cpuBudget: string
    capabilities: string
    traceSource: string
    browserImage: string
    datacenters: string
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
  add(labels.server, spec.server)
  add(labels.k8sContext, spec.context)
  add(labels.image, spec.image)
  add(labels.namespace, spec.namespace)
  add(labels.nomadRuntime, spec.runtime)
  add('RuntimeClass', spec.runtimeClass)
  add(labels.authSecret, spec.authSecret)
  add(labels.kubeconfigSecret, spec.kubeconfigSecret)
  // Admission envelope — what the scheduler may pack onto this runtime concurrently.
  add(
    labels.maxConcurrent,
    spec.maxConcurrent !== undefined ? String(spec.maxConcurrent) : undefined
  )
  add(
    labels.memoryBudget,
    spec.memoryBudgetMb !== undefined ? `${spec.memoryBudgetMb}Mb` : undefined
  )
  add(labels.cpuBudget, spec.cpuBudget !== undefined ? String(spec.cpuBudget) : undefined)
  add(labels.capabilities, spec.capabilities)
  add(
    labels.traceSource,
    spec.traceSource
      ? `${spec.traceSource.kind}${spec.traceSource.endpoint ? ` · ${spec.traceSource.endpoint}` : ''}`
      : undefined
  )
  add(labels.browserImage, spec.browserImage)
  add(labels.datacenters, spec.datacenters)
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

  // Get this runtime's summary (version/owner) from the list — go back to the list if absent or the connection fails.
  let summary: RuntimeSummary | undefined
  try {
    summary = runtimesSchema.parse(await controlPlane.listRuntimes(ctx)).find((r) => r.id === id)
  } catch {
    summary = undefined
  }
  if (!summary) redirect(`/${workspace}/runtimes`)

  // Versioning is an implementation detail here — always show/edit the latest; the version list is not surfaced.
  const latest = sortSemverDesc(summary.versions)[0] ?? summary.versions[0]
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
        server: t('specServer'),
        k8sContext: t('specK8sContext'),
        image: t('specImage'),
        namespace: t('specNamespace'),
        nomadRuntime: t('specNomadRuntime'),
        authSecret: t('specAuthSecret'),
        kubeconfigSecret: t('specKubeconfigSecret'),
        maxConcurrent: t('specMaxConcurrent'),
        memoryBudget: t('specMemoryBudget'),
        cpuBudget: t('specCpuBudget'),
        capabilities: t('specCapabilities'),
        traceSource: t('specTraceSource'),
        browserImage: t('specBrowserImage'),
        datacenters: t('specDatacenters'),
        tags: t('specTags'),
      })
    : []

  // Edit — same gate as registration (runtimes:write) + only in the owning workspace; local runtimes are dev-only (not editable here).
  const currentWorkspace = principal?.workspace ?? workspace
  const editable =
    can(principal?.roles, 'runtimes:write') &&
    summary.owner === currentWorkspace &&
    spec !== undefined &&
    spec.kind !== 'local'
  const cluster = spec?.kind === 'nomad' || spec?.kind === 'k8s'

  return (
    <div className="space-y-6">
      <Link
        href={`/${workspace}/runtimes`}
        className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronLeft className="size-3.5" />
        {t('title')}
      </Link>
      <PageHeader
        title={id}
        description={t('detailDescription')}
        actions={
          editable ? (
            <Link
              href={`/${workspace}/runtimes/${encodeURIComponent(id)}/edit`}
              className={buttonVariants({ variant: 'secondary', size: 'sm' })}
            >
              <Pencil className="size-3.5" />
              {t('edit')}
            </Link>
          ) : undefined
        }
      />
      {error || !spec ? (
        <Callout tone="danger">{t('loadError', { detail: error ? `: ${error}` : '' })}</Callout>
      ) : (
        <Card className="space-y-4 p-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="info">{spec.kind}</Badge>
            <Badge tone={summary.owner === '_shared' ? 'info' : 'neutral'}>
              {summary.owner === '_shared' ? t('sharedBadge') : t('workspaceBadge')}
            </Badge>
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
          {/* Health checks — connect to the cluster (connection) / validate the spec + referenced secrets (dry run), without running a job. */}
          {cluster && (
            <div className="border-t border-border pt-4">
              <RuntimeHealthActions spec={spec} />
            </div>
          )}
          {/* Live cluster view — composition/capacity/workload/stores of the registered cluster (read-only, on demand). */}
          {cluster && (
            <div className="border-t border-border pt-4">
              <RuntimeClusterStatus id={id} version={latest} />
            </div>
          )}
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
