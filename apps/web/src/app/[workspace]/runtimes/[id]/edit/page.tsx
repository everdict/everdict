import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ChevronLeft, Lock } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import { RegisterRuntimeForm } from '@/features/register-runtime'
import { runtimeSpecSchema, runtimesSchema, type RuntimeSpec } from '@/entities/runtime'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { bumpSemver, maxSemver, sortSemverDesc } from '@/shared/lib/semver'
import { Callout } from '@/shared/ui/callout'
import { Card } from '@/shared/ui/card'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// Edit a runtime — versions are immutable under the hood, so an edit prefills the latest spec and saves back as the next
// version (the user never sees version numbers). Same runtime, so id/kind are fixed; the form locks them.
export default async function EditRuntimePage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>
}) {
  const { workspace, id } = await params
  const t = await getTranslations('runtimesPage')
  const { principal, ctx } = await currentPrincipal()

  let summary: { owner: string; versions: string[] } | undefined
  try {
    summary = runtimesSchema.parse(await controlPlane.listRuntimes(ctx)).find((r) => r.id === id)
  } catch {
    summary = undefined
  }
  if (!summary) redirect(`/${workspace}/runtimes`)

  const currentWorkspace = principal?.workspace ?? workspace
  const allowed = can(principal?.roles, 'runtimes:write') && summary.owner === currentWorkspace

  const latest = sortSemverDesc(summary.versions)[0] ?? summary.versions[0]
  let spec: RuntimeSpec | undefined
  let loadError: string | undefined
  if (allowed && latest) {
    try {
      spec = runtimeSpecSchema.parse(await controlPlane.getRuntime(ctx, id, latest))
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e)
    }
  }
  // The next immutable version an edit registers — bump the highest semver by a patch (invisible to the user).
  const submitVersion = bumpSemver(maxSemver(summary.versions) ?? latest ?? '1.0.0', 'patch')

  return (
    <div className="space-y-6">
      <Link
        href={`/${workspace}/runtimes/${encodeURIComponent(id)}`}
        className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronLeft className="size-3.5" />
        {id}
      </Link>
      <PageHeader title={t('editTitle')} description={t('editDescription', { id })} />
      {!allowed ? (
        <EmptyState icon={<Lock />} title={t('editNoPermTitle')} hint={t('editNoPermHint')} />
      ) : loadError || !spec ? (
        <Callout tone="danger">
          {t('loadError', { detail: loadError ? `: ${loadError}` : '' })}
        </Callout>
      ) : spec.kind === 'local' ? (
        <Callout tone="warning">{t('notEditableLocal')}</Callout>
      ) : (
        <Card className="p-5">
          <RegisterRuntimeForm workspace={workspace} initial={spec} submitVersion={submitVersion} />
        </Card>
      )}
    </div>
  )
}
