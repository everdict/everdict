import { getTranslations } from 'next-intl/server'
import { z } from 'zod'

import { fsEntrySchema, type FsEntryView } from '@/entities/workspace-file'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

import { SettingsFilesExplorer } from './settings-files-explorer'

export const dynamic = 'force-dynamic'

// Settings › Files — the workspace filesystem (the workspace's own isolated bucket), browsed entirely
// in-service: the page is the folder tree, and a selected file renders interactively in the right-hand
// split-view panel. Read = files:read (viewer+); writes pre-gate on files:write (control-plane enforced).
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

  let entries: FsEntryView[] = []
  let error: string | undefined
  try {
    entries = z.array(fsEntrySchema).parse(await controlPlane.listFsEntries(ctx, ''))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  return (
    <div className="space-y-6">
      {header}
      {error !== undefined ? (
        <EmptyState title={f('loadError')} hint={error} />
      ) : (
        <SettingsFilesExplorer
          initialEntries={entries}
          canWrite={can(principal.roles, 'files:write')}
        />
      )}
    </div>
  )
}
