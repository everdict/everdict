'use client'

import { File as FileIcon } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { FileViewer } from '@/features/browse-files'
import { EmptyState } from '@/shared/ui/empty-state'

import { useInfraPanel } from '../model/infra-panel-context'

// The panel's files tab — the selected workspace-filesystem file rendered interactively (Markdown preview,
// code, images, member editing) right in the split view. Purpose-built like the work/agent tabs (no iframe):
// re-selecting in the Settings › Files tree swaps the content in place instead of reloading a document. A save
// here bumps fsRevision so the tree on the left refetches; deleting is the TREE's job (it owns the list
// actions), and it calls closeFile when the deletion carried away what this tab was showing.
export function FilesTab({ canWrite }: { canWrite: boolean }) {
  const t = useTranslations('files')
  const { filePath, notifyFsMutation } = useInfraPanel()

  if (filePath === null) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <EmptyState title={t('selectFile')} icon={<FileIcon />} />
      </div>
    )
  }
  return (
    <div className="h-full overflow-y-auto">
      <FileViewer path={filePath} canWrite={canWrite} onMutated={notifyFsMutation} />
    </div>
  )
}
