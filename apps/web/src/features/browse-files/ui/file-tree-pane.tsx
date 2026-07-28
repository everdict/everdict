'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  File as FileIcon,
  FilePlus2,
  Folder,
  FolderPlus,
  Loader2,
  RefreshCw,
} from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { FsEntryView } from '@/entities/workspace-file'
import { fmtBytes } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Dialog } from '@/shared/ui/dialog'
import { EmptyState } from '@/shared/ui/empty-state'
import { Input, Label } from '@/shared/ui/input'

import { listFilesAction, makeDirectoryAction, writeFileAction } from '../api/browse-files'

// The filesystem tree card — lazy per-directory loading, create (file/folder) + refresh toolbar. Selection is
// CONTROLLED: the host owns selectedPath and receives clicks via onOpenFile, so the same tree drives either an
// inline viewer (the Files workbench) or the infra panel's file tab (Settings › Files). refreshToken bumps make
// the tree refetch in place after an out-of-band mutation (viewer save/move/delete, the shell).

type DirCache = Record<string, FsEntryView[]>

type DialogMode = { kind: 'new-file' } | { kind: 'new-folder' } | null

export function FileTreePane({
  initialEntries,
  canWrite,
  selectedPath,
  onOpenFile,
  refreshToken,
}: {
  initialEntries: FsEntryView[]
  canWrite: boolean
  selectedPath?: string
  onOpenFile: (path: string) => void
  refreshToken?: number // bump from outside to refetch the tree (root + expanded dirs)
}) {
  const t = useTranslations('files')
  const [dirs, setDirs] = useState<DirCache>({ '': initialEntries })
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [dialog, setDialog] = useState<DialogMode>(null)
  const [dialogPath, setDialogPath] = useState('')
  const [dialogError, setDialogError] = useState<string | undefined>(undefined)
  const [dialogBusy, setDialogBusy] = useState(false)

  const loadDir = useCallback(async (path: string) => {
    const res = await listFilesAction(path)
    if (res.ok && res.data) setDirs((prev) => ({ ...prev, [path]: res.data ?? [] }))
    return res
  }, [])

  // One refresh for every mutation source: refetch the root and every expanded dir.
  const refreshAll = useCallback(() => {
    void loadDir('')
    for (const dir of expanded) void loadDir(dir)
  }, [expanded, loadDir])

  // An outside mutation bumps refreshToken → refetch the tree in place.
  // Deliberately keyed on the token alone — refreshAll identity churn must not re-trigger the sweep.
  useEffect(() => {
    if (refreshToken !== undefined && refreshToken > 0) refreshAll()
  }, [refreshToken])

  async function toggleDir(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
    if (!(path in dirs)) await loadDir(path)
  }

  async function submitDialog() {
    if (dialog === null) return
    const path = dialogPath.trim().replace(/^\/+/, '')
    if (path === '') return
    setDialogBusy(true)
    setDialogError(undefined)
    const res =
      dialog.kind === 'new-file'
        ? await writeFileAction({ path, content: '' })
        : await makeDirectoryAction(path)
    setDialogBusy(false)
    if (!res.ok) {
      setDialogError(res.error)
      return
    }
    setDialog(null)
    refreshAll()
    if (dialog.kind === 'new-file') onOpenFile(path)
  }

  function renderTree(dir: string, depth: number) {
    const entries = dirs[dir]
    if (!entries) {
      return (
        <div
          className="flex items-center gap-2 px-2 py-1 text-[12.5px] text-muted-foreground"
          style={{ paddingLeft: depth * 14 + 8 }}
        >
          <Loader2 className="size-3.5 animate-spin" />
        </div>
      )
    }
    if (entries.length === 0 && dir === '') {
      return (
        <div className="p-2">
          <EmptyState title={t('emptyRootTitle')} hint={t('emptyRootHint')} />
        </div>
      )
    }
    return entries.map((entry) => (
      <div key={entry.path}>
        {entry.kind === 'dir' ? (
          <>
            <button
              type="button"
              onClick={() => void toggleDir(entry.path)}
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[12.5px] text-foreground hover:bg-accent"
              style={{ paddingLeft: depth * 14 + 8 }}
            >
              {expanded.has(entry.path) ? (
                <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <Folder className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{entry.name}</span>
            </button>
            {expanded.has(entry.path) && renderTree(entry.path, depth + 1)}
          </>
        ) : (
          <button
            type="button"
            onClick={() => onOpenFile(entry.path)}
            className={cn(
              'flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[12.5px] hover:bg-accent',
              selectedPath === entry.path ? 'bg-accent text-foreground' : 'text-muted-foreground'
            )}
            style={{ paddingLeft: depth * 14 + 8 + 18 }}
          >
            <FileIcon className="size-3.5 shrink-0" />
            <span className="truncate">{entry.name}</span>
            {entry.size !== undefined && (
              <span className="ml-auto shrink-0 text-[11px] text-muted-foreground/70">
                {fmtBytes(entry.size)}
              </span>
            )}
          </button>
        )}
      </div>
    ))
  }

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-2.5 py-1.5">
        <span className="px-1 text-[13px] font-[510] text-foreground">{t('treeTitle')}</span>
        <div className="flex items-center gap-0.5">
          {canWrite && (
            <>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('newFile')}
                title={t('newFile')}
                onClick={() => {
                  setDialog({ kind: 'new-file' })
                  setDialogPath('')
                  setDialogError(undefined)
                }}
              >
                <FilePlus2 />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('newFolder')}
                title={t('newFolder')}
                onClick={() => {
                  setDialog({ kind: 'new-folder' })
                  setDialogPath('')
                  setDialogError(undefined)
                }}
              >
                <FolderPlus />
              </Button>
            </>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('refresh')}
            title={t('refresh')}
            onClick={refreshAll}
          >
            <RefreshCw />
          </Button>
        </div>
      </div>
      <div className="max-h-[480px] overflow-y-auto p-1.5">{renderTree('', 0)}</div>
      {!canWrite && (
        <div className="border-t border-border px-3 py-2 text-[11.5px] text-muted-foreground">
          {t('readOnlyNotice')}
        </div>
      )}

      {/* path dialog: new file / new folder */}
      <Dialog open={dialog !== null} onClose={() => setDialog(null)} className="max-w-md">
        <div className="space-y-3 p-4">
          <p className="text-[13.5px] font-[510] text-foreground">
            {dialog?.kind === 'new-file' ? t('newFile') : t('newFolder')}
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="fs-path-input">{t('pathLabel')}</Label>
            <Input
              id="fs-path-input"
              value={dialogPath}
              onChange={(e) => setDialogPath(e.target.value)}
              placeholder={dialog?.kind === 'new-folder' ? t('newFolderPath') : t('newFilePath')}
              autoFocus
              spellCheck={false}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submitDialog()
              }}
            />
          </div>
          {dialogError !== undefined && (
            <p className="text-[12.5px] text-destructive">{dialogError}</p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setDialog(null)}>
              {t('cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={dialogBusy || dialogPath.trim() === ''}
              onClick={() => void submitDialog()}
            >
              {t('create')}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  )
}
