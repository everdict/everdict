'use client'

import { useCallback, useState } from 'react'
import { File as FileIcon } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { FsEntryView } from '@/entities/workspace-file'
import { EmptyState } from '@/shared/ui/empty-state'

import { rewriteMovedPath } from '../lib/fs-path'
import { FileShell } from './file-shell'
import { FileTreePane } from './file-tree-pane'
import { FileViewer } from './file-viewer'

// The Files workbench — tree (FileTreePane, drag-and-drop moves included) + inline viewer/editor (FileViewer)
// + the bash-style shell. Every mutation source (viewer save/delete, a dragged move, shell commands) bumps one
// refresh token so the tree refetches in place. Read-only for viewers; members write (control-plane enforced;
// the UI pre-gates for honest affordances).
export function FilesWorkbench({
  initialEntries,
  canWrite,
}: {
  initialEntries: FsEntryView[]
  canWrite: boolean
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
              onMutated={refreshTree}
              onDeleted={() => setSelectedPath(undefined)}
            />
          )}
        </div>
      </div>

      <FileShell canWrite={canWrite} onMutated={refreshTree} />
    </div>
  )
}
