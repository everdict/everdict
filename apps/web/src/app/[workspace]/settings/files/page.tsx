import { getTranslations } from 'next-intl/server'
import { z } from 'zod'

import { FilesSettings } from '@/features/browse-files'
import {
  fsEntrySchema,
  fsUsageSchema,
  type FsEntryView,
  type FsUsageView,
} from '@/entities/workspace-file'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// Settings › Files — govern the workspace filesystem entirely IN-SERVICE (never the object-storage console):
// the storage picture (totals + per-top-level breakdown) and cleanup (per-entry recursive delete = files:write;
// whole-tree clear = settings:write/admin). Browsing/rendering/editing lives on the main Files page.
export default async function FilesSettingsPage() {
  const t = await getTranslations('settingsNav')
  const f = await getTranslations('files')
  const s = await getTranslations('settingsPage')
  const { principal, ctx } = await currentPrincipal()
  const canRead = can(principal?.roles, 'files:read')
  const header = <PageHeader title={t('files')} description={t('filesDesc')} />
  if (!canRead || !principal) {
    return (
      <div className="space-y-6">
        {header}
        <EmptyState title={s('noPermissionTitle')} hint={s('noPermissionHint')} />
      </div>
    )
  }

  let usage: FsUsageView | undefined
  let entries: FsEntryView[] = []
  let error: string | undefined
  try {
    usage = fsUsageSchema.parse(await controlPlane.fsUsage(ctx))
    entries = z.array(fsEntrySchema).parse(await controlPlane.listFsEntries(ctx, ''))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  return (
    <div className="space-y-6">
      {header}
      {usage === undefined ? (
        <EmptyState title={f('loadError')} hint={error} />
      ) : (
        <FilesSettings
          workspace={principal.workspace}
          initialUsage={usage}
          initialEntries={entries}
          canWrite={can(principal.roles, 'files:write')}
          canManage={can(principal.roles, 'settings:write')}
        />
      )}
    </div>
  )
}
