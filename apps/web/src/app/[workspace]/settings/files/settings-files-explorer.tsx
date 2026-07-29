'use client'

import { FileTreePane, rewriteMovedPath } from '@/features/browse-files'
import type { FsEntryView } from '@/entities/workspace-file'
import { useInfraPanelOptional } from '@/widgets/infra-panel'

// Settings › Files — the explorer is the tree ALONE: selecting a file opens it in the right-hand split-view
// panel (the infra panel's files tab), rendered interactively there instead of an inline pane. The panel
// mirrors the selection back (highlight follows filePath) and its mutations bump fsRevision so the tree
// refetches in place. Optional context: a framed render (no provider) is a transient bounced state — degrade
// to a no-op selection instead of crashing before the bounce guard escapes the document.
export function SettingsFilesExplorer({
  initialEntries,
  canWrite,
}: {
  initialEntries: FsEntryView[]
  canWrite: boolean
}) {
  const infra = useInfraPanelOptional()
  const filePath = infra?.filePath ?? null
  return (
    <FileTreePane
      initialEntries={initialEntries}
      canWrite={canWrite}
      {...(filePath !== null ? { selectedPath: filePath } : {})}
      onOpenFile={(path) => infra?.openFile(path)}
      onMoved={(from, to) => {
        // A drag carried the open file (or the folder holding it) elsewhere — follow it in the panel.
        const next = rewriteMovedPath(filePath ?? undefined, from, to)
        if (next !== undefined) infra?.openFile(next)
      }}
      refreshToken={infra?.fsRevision ?? 0}
    />
  )
}
