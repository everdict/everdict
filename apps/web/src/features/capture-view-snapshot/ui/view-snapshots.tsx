import { getTranslations } from 'next-intl/server'

import { fsEntrySchema, type FsEntryView } from '@/entities/workspace-file'
import { can } from '@/shared/auth/can'
import { authContext, currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { EmptyState } from '@/shared/ui/empty-state'
import { SectionHeader } from '@/shared/ui/section-header'

import { CaptureSnapshotButton } from './capture-snapshot-button'
import { SnapshotList } from './snapshot-list'

// A View re-runs live and remembers nothing; captures are the accumulating record of what it said. They are
// plain files under views/<id>/ on the workspace filesystem, so this section lists them straight from the /fs
// surface — no view-snapshot read endpoint exists, and none is needed.
export async function ViewSnapshots({ workspace, viewId }: { workspace: string; viewId: string }) {
  const t = await getTranslations('viewSnapshots')
  const { principal } = await currentPrincipal()
  const canCapture = can(principal?.roles, 'scorecards:run')

  let entries: FsEntryView[] = []
  try {
    const ctx = await authContext()
    entries = fsEntrySchema
      .array()
      .parse(await controlPlane.listFsEntries(ctx, `views/${viewId}`))
      .filter((e) => e.kind === 'file' && e.name.endsWith('.json'))
  } catch {
    // A filesystem that is unreachable (or has never been written to) collapses the section to its empty
    // state — the View itself must keep rendering.
    entries = []
  }

  return (
    <section className="space-y-3">
      <SectionHeader
        title={t('title')}
        action={
          canCapture ? <CaptureSnapshotButton workspace={workspace} viewId={viewId} /> : undefined
        }
      />
      {entries.length === 0 ? (
        <EmptyState title={t('emptyTitle')} hint={t('emptyHint')} />
      ) : (
        <SnapshotList entries={[...entries].reverse()} />
      )}
    </section>
  )
}
