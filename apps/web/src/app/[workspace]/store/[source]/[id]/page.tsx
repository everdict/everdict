import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import { CapabilityDetailView, capKey } from '@/features/publish-capability'
// A server-only loader (controlPlane), so it is imported directly rather than through the barrel the client uses (following the store list page).
import { loadStoreContext } from '@/features/publish-capability/api/store-context'
import { capabilitySchema, type Capability } from '@/entities/capability'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { fmtSubject } from '@/shared/lib/format'
import { EmptyState } from '@/shared/ui/empty-state'
import { Link } from '@/shared/ui/link'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// Store › detail — everything about one entry, addressed by its publishing workspace (source, `_shared` for managed ones) and its id.
// A detail is always a route and never a dialog: a modal covering half the screen makes it impossible to experiment on this entry with the
// infra/conversation panel on the right, and impossible to share as a link. `?from=mine` marks an entry from MY publications list — the back
// link returns there and the visibility badge is shown alongside (in the public catalog the visibility is public with nothing to see).
export default async function StoreCapabilityPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; source: string; id: string }>
  searchParams: Promise<{ from?: string }>
}) {
  const { workspace, source: rawSource, id: rawId } = await params
  const { from } = await searchParams
  const source = decodeURIComponent(rawSource)
  const id = decodeURIComponent(rawId)
  const t = await getTranslations('capabilityStore')
  const { principal, ctx } = await currentPrincipal()
  if (!can(principal?.roles, 'capabilities:read')) {
    return <EmptyState title={t('noPermissionTitle')} hint={t('noPermissionHint')} />
  }

  let capability: Capability
  try {
    capability = capabilitySchema.parse(
      await controlPlane.getCapability(ctx, id, undefined, source)
    )
  } catch {
    notFound() // absent, or a publication not visible to me — a 404 that leaks no existence (the control plane judges).
  }

  const store = await loadStoreContext(ctx)
  const currentWorkspace = principal?.workspace ?? workspace
  const variant = from === 'mine' ? 'mine' : 'catalog'
  const key = capKey(capability)
  const adoptedEnv = store.adoptedEnvironments.find((e) => `${e.source}/${e.id}` === key)
  // Is it already in the workspace — an environment is the inventory, a skill is a library copy, everything else an agent adoption (the same judgement as the list).
  const inWorkspace =
    capability.spec.type === 'environment'
      ? adoptedEnv !== undefined
      : capability.spec.type === 'skill'
        ? store.importedSkillKeys.includes(key)
        : store.adoptedKeys.includes(key)
  const profile = store.authors[capability.createdBy]
  const author = {
    name: profile?.name ?? fmtSubject(capability.createdBy),
    ...(profile?.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}),
  }

  return (
    <div className="space-y-6">
      <Link
        href={variant === 'mine' ? `/${workspace}/store/mine` : `/${workspace}/store`}
        className="inline-flex items-center gap-1 text-[13px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        {t(variant === 'mine' ? 'backToMine' : 'backToStore')}
      </Link>
      <PageHeader title={capability.name} description={capability.description} />
      <CapabilityDetailView
        capability={capability}
        variant={variant}
        author={author}
        currentWorkspace={currentWorkspace}
        isAdmin={(principal?.roles ?? []).includes('admin')}
        inWorkspace={inWorkspace}
        {...(adoptedEnv ? { adoptedEnv } : {})}
        canAdopt={can(principal?.roles, 'agents:write')} // adopting = editing MY agent configuration
        canImportEnvironment={can(principal?.roles, 'settings:write')} // an environment = the workspace inventory
        canImportSkill={can(principal?.roles, 'skills:write')} // a skill = making a COPY in the library
        secretNames={store.secretNames}
        {...(principal?.subject !== undefined ? { currentSubject: principal.subject } : {})}
      />
    </div>
  )
}
