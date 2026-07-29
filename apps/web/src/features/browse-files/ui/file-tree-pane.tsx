'use client'

import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
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

import {
  listFilesAction,
  makeDirectoryAction,
  moveEntryAction,
  writeFileAction,
} from '../api/browse-files'
import { baseNameOf, displayPath, parentOf } from '../lib/fs-path'

// The filesystem tree card — lazy per-directory loading, create (file/folder) + refresh toolbar, and
// drag-and-drop relocation (the tree IS the move affordance; the viewer has no move button). Selection is
// CONTROLLED: the host owns selectedPath and receives clicks via onOpenFile, so the same tree drives either an
// inline viewer (the Files workbench) or the infra panel's file tab (Settings › Files). refreshToken bumps make
// the tree refetch in place after an out-of-band mutation (viewer save/delete, the shell).

type DirCache = Record<string, FsEntryView[]>

type DialogMode = { kind: 'new-file' } | { kind: 'new-folder' } | null

// Our own drag payload type — a drop only reacts to a drag that started in this tree, never to OS files or
// text dragged in from elsewhere (dragover checks the type list; the path itself is unreadable until drop).
const FS_DRAG_TYPE = 'application/x-everdict-fs-path'

const HOVER_EXPAND_MS = 600 // hovering a collapsed folder mid-drag opens it, so nested targets are reachable

export function FileTreePane({
  initialEntries,
  canWrite,
  selectedPath,
  onOpenFile,
  onMoved,
  refreshToken,
}: {
  initialEntries: FsEntryView[]
  canWrite: boolean
  selectedPath?: string
  onOpenFile: (path: string) => void
  onMoved?: (from: string, to: string) => void // the host re-points a selection the move carried away
  refreshToken?: number // bump from outside to refetch the tree (root + expanded dirs)
}) {
  const t = useTranslations('files')
  const [dirs, setDirs] = useState<DirCache>({ '': initialEntries })
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [dialog, setDialog] = useState<DialogMode>(null)
  const [dialogPath, setDialogPath] = useState('')
  const [dialogError, setDialogError] = useState<string | undefined>(undefined)
  const [dialogBusy, setDialogBusy] = useState(false)
  const [dragPath, setDragPath] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [moving, setMoving] = useState(false)
  const [moveError, setMoveError] = useState<string | undefined>(undefined)
  const hoverExpand = useRef<{ path: string; timer: ReturnType<typeof setTimeout> } | null>(null)

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

  const clearHoverExpand = useCallback(() => {
    if (hoverExpand.current) clearTimeout(hoverExpand.current.timer)
    hoverExpand.current = null
  }, [])

  useEffect(() => clearHoverExpand, [clearHoverExpand])

  function expandDir(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      next.add(path)
      return next
    })
    void loadDir(path)
  }

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

  // Where a drag may land: not on itself, not back into the folder it already sits in, and — for a folder —
  // never inside its own subtree (the control plane rejects that too; refusing here keeps the cursor honest).
  function canDropInto(target: string, source: string | null): boolean {
    if (source === null) return false
    if (target === source || parentOf(source) === target) return false
    return !target.startsWith(`${source}/`)
  }

  async function runMove(from: string, targetDir: string) {
    clearHoverExpand()
    setDropTarget(null)
    setDragPath(null)
    const to = targetDir === '' ? baseNameOf(from) : `${targetDir}/${baseNameOf(from)}`
    if (to === from) return
    setMoveError(undefined)
    setMoving(true)
    const res = await moveEntryAction(from, to)
    setMoving(false)
    if (!res.ok) {
      setMoveError(res.error)
      return
    }
    if (targetDir !== '') expandDir(targetDir) // reveal where it landed
    refreshAll()
    onMoved?.(from, to)
  }

  // Drop-target wiring, shared by folder rows (drop INTO that folder), file rows (drop into the folder the file
  // sits in) and the tree body (drop at the root). Rows stop propagation so the row under the cursor — not the
  // container it bubbles through — decides the target.
  function dropProps(targetDir: string, stop: boolean) {
    return {
      onDragOver: (e: DragEvent<HTMLElement>) => {
        if (!canWrite || !e.dataTransfer.types.includes(FS_DRAG_TYPE)) return
        if (stop) e.stopPropagation()
        if (!canDropInto(targetDir, dragPath)) {
          setDropTarget(null)
          return // no preventDefault → the cursor shows "not allowed"
        }
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setDropTarget(targetDir)
        if (
          targetDir !== '' &&
          !expanded.has(targetDir) &&
          hoverExpand.current?.path !== targetDir
        ) {
          clearHoverExpand()
          hoverExpand.current = {
            path: targetDir,
            timer: setTimeout(() => expandDir(targetDir), HOVER_EXPAND_MS),
          }
        }
      },
      onDrop: (e: DragEvent<HTMLElement>) => {
        if (!canWrite || !e.dataTransfer.types.includes(FS_DRAG_TYPE)) return
        e.preventDefault()
        if (stop) e.stopPropagation()
        const from = e.dataTransfer.getData(FS_DRAG_TYPE)
        if (from !== '' && canDropInto(targetDir, from)) void runMove(from, targetDir)
        else {
          clearHoverExpand()
          setDropTarget(null)
          setDragPath(null)
        }
      },
    }
  }

  function dragProps(path: string) {
    if (!canWrite) return {}
    return {
      draggable: true,
      onDragStart: (e: DragEvent<HTMLElement>) => {
        e.dataTransfer.setData(FS_DRAG_TYPE, path)
        e.dataTransfer.setData('text/plain', displayPath(path))
        e.dataTransfer.effectAllowed = 'move'
        setMoveError(undefined)
        setDragPath(path)
      },
      onDragEnd: () => {
        clearHoverExpand()
        setDragPath(null)
        setDropTarget(null)
      },
    }
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
              {...dragProps(entry.path)}
              {...dropProps(entry.path, true)}
              className={cn(
                'flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[12.5px] text-foreground hover:bg-accent',
                dropTarget === entry.path && 'bg-primary/10 ring-1 ring-primary/50',
                dragPath === entry.path && 'opacity-50'
              )}
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
            {...dragProps(entry.path)}
            {...dropProps(dir, true)}
            className={cn(
              'flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[12.5px] hover:bg-accent',
              selectedPath === entry.path ? 'bg-accent text-foreground' : 'text-muted-foreground',
              dragPath === entry.path && 'opacity-50'
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
        <span className="flex items-center gap-1.5 px-1 text-[13px] font-[510] text-foreground">
          {t('treeTitle')}
          {moving && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
        </span>
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
      {/* The body is the root drop zone — dragging an entry out here moves it to the top level. */}
      <div
        {...dropProps('', false)}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            clearHoverExpand()
            setDropTarget(null)
          }
        }}
        className={cn(
          'max-h-[480px] overflow-y-auto p-1.5',
          dropTarget === '' && 'bg-primary/5 ring-1 ring-inset ring-primary/40'
        )}
      >
        {renderTree('', 0)}
      </div>
      {moveError !== undefined && (
        <div className="border-t border-border px-3 py-2 text-[11.5px] text-destructive">
          {t('moveFailed')} — {moveError}
        </div>
      )}
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
