'use client'

import { useInfraPanelOptional } from '@/widgets/infra-panel'
import { coversPath, FileTreePane, rewriteMovedPath } from '@/features/browse-files'
import type { FsEntryView } from '@/entities/workspace-file'

// Settings › Files — the explorer is the tree ALONE: selecting a file opens it in the right-hand split-view
// panel (the infra panel's files tab), rendered interactively there instead of an inline pane. The tree is
// also where the list actions live (per-row and multi-select delete, drag or "Move to…" relocation), so it
// re-points or closes the panel when an action carries the open document away. The panel mirrors the selection
// back (highlight follows filePath) and its mutations bump fsRevision so the tree refetches in place. Optional
// context: a framed render (no provider) is a transient bounced state — degrade to a no-op selection instead
// of crashing before the bounce guard escapes the document.
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
        // A move carried the open file (or the folder holding it) elsewhere — follow it in the panel.
        const next = rewriteMovedPath(filePath ?? undefined, from, to)
        if (next !== undefined) infra?.openFile(next)
      }}
      onRemoved={(paths) => {
        // The open file was deleted (directly or with its folder) — the panel falls back to its empty state.
        if (filePath !== null && paths.some((root) => coversPath(root, filePath)))
          infra?.closeFile()
      }}
      refreshToken={infra?.fsRevision ?? 0}
    />
  )
}
