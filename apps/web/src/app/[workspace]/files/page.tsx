import { getTranslations } from 'next-intl/server'
import { z } from 'zod'

import { FilesWorkbench } from '@/features/browse-files'
import { FileSearch } from '@/features/search-files'
import { fsEntrySchema, type FsEntryView } from '@/entities/workspace-file'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// The workspace Files page — the shared, workspace-isolated filesystem browsed like a shell: a lazy tree +
// viewer/editor + a bash-style shell. Agents persist task outputs here (write_file); the team reads, edits, and
// reorganizes them. Read = files:read (viewer+); every mutation pre-gates on files:write (control-plane enforced).
export default async function FilesPage() {
  const t = await getTranslations('files')
  const { principal, ctx } = await currentPrincipal()

  let entries: FsEntryView[] = []
  let error: string | undefined
  try {
    entries = z.array(fsEntrySchema).parse(await controlPlane.listFsEntries(ctx, ''))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  // What the tree COSTS. Best-effort: a usage read that fails must not take the browser down with it — the
  // page's job is the files, and the number is a header line. Absent reads as "not measured", never as 0.
  let usage: { bytes?: number; files?: number } | undefined
  try {
    usage = await controlPlane.fsUsage<{ bytes?: number; files?: number }>(ctx)
  } catch {
    usage = undefined
  }

  const canWrite = can(principal?.roles, 'files:write')
  // Running a file needs BOTH the permission and a deployment that composed an execution driver (GET /me).
  const canRun = canWrite && principal?.config?.fileExecution === true

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          usage?.bytes !== undefined ? (
            <span className="text-[12px] text-muted-foreground">
              {t('usage', { mb: Math.round(usage.bytes / 1024 / 1024), files: usage.files ?? 0 })}
            </span>
          ) : undefined
        }
      />
      {error === undefined && <FileSearch />}
      {error !== undefined ? (
        <EmptyState title={t('loadError')} hint={error} />
      ) : (
        <FilesWorkbench initialEntries={entries} canWrite={canWrite} canRun={canRun} />
      )}
    </div>
  )
}
