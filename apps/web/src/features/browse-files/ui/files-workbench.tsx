'use client'

import { useCallback, useState } from 'react'
import { File as FileIcon } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { FsEntryView } from '@/entities/workspace-file'
import { EmptyState } from '@/shared/ui/empty-state'

import { coversPath, rewriteMovedPath } from '../lib/fs-path'
import { FileShell } from './file-shell'
import { FileTreePane } from './file-tree-pane'
import { FileViewer } from './file-viewer'

// The Files workbench — tree (FileTreePane: the list actions, moves and deletes, live there) + inline
// viewer/editor (FileViewer) + the bash-style shell. Every mutation source (a viewer save, a tree move/delete,
// shell commands) bumps one refresh token so the tree refetches in place. Read-only for viewers; members write
// (control-plane enforced; the UI pre-gates for honest affordances).
export function FilesWorkbench({
  initialEntries,
  canWrite,
  canRun = false,
}: {
  initialEntries: FsEntryView[]
  canWrite: boolean
  canRun?: boolean
}) {
  const t = useTranslations('files')
  const [selectedPath, setSelectedPath] = useState<string | undefined>(undefined)
  const [refreshToken, setRefreshToken] = useState(0)

  const refreshTree = useCallback(() => setRefreshToken((token) => token + 1), [])

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
        <FileTreePane
          initialEntries={initialEntries}
          canWrite={canWrite}
          {...(selectedPath !== undefined ? { selectedPath } : {})}
          onOpenFile={setSelectedPath}
          onMoved={(from, to) =>
            setSelectedPath((current) => rewriteMovedPath(current, from, to) ?? current)
          }
          onRemoved={(paths) =>
            // The open document is gone (deleted itself, or a deleted folder took it) — fall back to the empty state.
            setSelectedPath((current) =>
              current !== undefined && paths.some((root) => coversPath(root, current))
                ? undefined
                : current
            )
          }
          refreshToken={refreshToken}
        />

        {/* viewer pane */}
        <div className="min-w-0 rounded-lg border border-border bg-card">
          {selectedPath === undefined ? (
            <div className="flex h-full min-h-[320px] items-center justify-center">
              <EmptyState title={t('selectFile')} icon={<FileIcon />} />
            </div>
          ) : (
            <FileViewer
              path={selectedPath}
              canWrite={canWrite}
              canRun={canRun}
              onMutated={refreshTree}
            />
          )}
        </div>
      </div>

      <FileShell canWrite={canWrite} onMutated={refreshTree} />
    </div>
  )
}
