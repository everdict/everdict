'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import {
  Check,
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  File as FileIcon,
  FilePlus2,
  Folder,
  FolderPlus,
  Loader2,
  RefreshCw,
  Trash2,
  Upload,
} from 'lucide-react'
import { useLocale, useTimeZone, useTranslations } from 'next-intl'
import { createPortal } from 'react-dom'

import type { FsEntryView } from '@/entities/workspace-file'
import { fmtBytes, fmtDateTimeFull, fmtTimeAgo } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Dialog } from '@/shared/ui/dialog'
import { EmptyState } from '@/shared/ui/empty-state'
import { Input, Label } from '@/shared/ui/input'

import {
  listFilesAction,
  makeDirectoryAction,
  moveEntriesAction,
  writeFileAction,
} from '../api/browse-files'
import { uploadFilesInto, type UploadFailure } from '../api/upload-files'
import {
  baseNameOf,
  coversPath,
  displayPath,
  joinFsPath,
  movablePaths,
  parentOf,
  pruneRedundantPaths,
  rewriteMovedPath,
  type FsTarget,
} from '../lib/fs-path'
import { DeleteEntriesDialog } from './delete-entries-dialog'
import { MoveEntriesDialog } from './move-entries-dialog'

// The filesystem tree card — lazy per-directory loading, create (file/folder) + upload + refresh toolbar, and the entry
// LIST actions: delete lives here (a per-row trash and a multi-select bulk delete), not in the viewer, and so
// does relocation (drag-and-drop, plus "Move to…" for a destination the drag can't reach). Multi-select follows
// the scorecard-list grammar — hover-revealed checkboxes, shift-click ranges, Esc to clear, and a floating
// action bar over the content region. Selection is CONTROLLED: the host owns selectedPath and receives clicks
// via onOpenFile, so the same tree drives either an inline viewer (the Files workbench) or the infra panel's
// file tab (Settings › Files). refreshToken bumps make the tree refetch in place after an out-of-band mutation.

type DirCache = Record<string, FsEntryView[]>

type DialogMode = { kind: 'new-file' } | { kind: 'new-folder' } | null

// The bulk action awaiting confirmation — the row trash opens the delete one with a single target.
type BulkAction = { kind: 'delete' | 'move'; targets: FsTarget[] } | null

// Our own drag payload type — it tells an in-tree MOVE from everything else: a drag carrying this type moves
// entries, a drag carrying OS files ('Files' in the type list) uploads them into the hovered folder, and text
// dragged in from elsewhere still does nothing (dragover checks the type list; the payloads are unreadable until
// drop). The payload is a JSON array: dragging a selected row carries the whole selection, not just the row
// under the cursor.
const FS_DRAG_TYPE = 'application/x-everdict-fs-paths'

const HOVER_EXPAND_MS = 600 // hovering a collapsed folder mid-drag opens it, so nested targets are reachable

function parseDragPaths(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : []
  } catch {
    return [] // not our payload (or a truncated one) — the drop is simply ignored
  }
}

export function FileTreePane({
  initialEntries,
  canWrite,
  selectedPath,
  onOpenFile,
  onMoved,
  onRemoved,
  refreshToken,
}: {
  initialEntries: FsEntryView[]
  canWrite: boolean
  selectedPath?: string
  onOpenFile: (path: string) => void
  onMoved?: (from: string, to: string) => void // the host re-points a selection the move carried away
  onRemoved?: (paths: string[]) => void // the host closes a viewer whose file the deletion took with it
  refreshToken?: number // bump from outside to refetch the tree (root + expanded dirs)
}) {
  const t = useTranslations('files')
  const locale = useLocale()
  const timeZone = useTimeZone()
  const [dirs, setDirs] = useState<DirCache>({ '': initialEntries })
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [dialog, setDialog] = useState<DialogMode>(null)
  const [dialogPath, setDialogPath] = useState('')
  const [dialogError, setDialogError] = useState<string | undefined>(undefined)
  const [dialogBusy, setDialogBusy] = useState(false)
  const [dragPaths, setDragPaths] = useState<string[]>([])
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [moving, setMoving] = useState(false)
  const [moveError, setMoveError] = useState<string | undefined>(undefined)
  const [uploadBusy, setUploadBusy] = useState(false)
  const [uploadError, setUploadError] = useState<string | undefined>(undefined)
  const uploadInput = useRef<HTMLInputElement>(null)
  // Checked entries, by path. Not persisted (unlike the scorecard list): the tree never navigates away, and a
  // path is not a stable id — a move or a delete rewrites it, so a restored selection would point at ghosts.
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulk, setBulk] = useState<BulkAction>(null)
  const hoverExpand = useRef<{ path: string; timer: ReturnType<typeof setTimeout> } | null>(null)
  const selectionMode = selected.size > 0

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

  // Esc drops the whole selection — skipped while a dialog is up, where Esc means "close the dialog".
  useEffect(() => {
    if (!selectionMode || bulk !== null || dialog !== null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelected(new Set())
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectionMode, bulk, dialog])

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
        ? // baseRevision 0 = "this file should not exist yet": creating over an existing path is refused (409)
          // instead of silently replacing someone's file with an empty one.
          await writeFileAction({ path, content: '', baseRevision: 0 })
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

  // Every entry the tree has loaded (including collapsed branches) — the source for an entry's kind and for the
  // "Move to…" destination list, both of which must answer for paths that are currently out of view.
  const entryByPath = useMemo(() => {
    const map = new Map<string, FsEntryView>()
    for (const entries of Object.values(dirs))
      for (const entry of entries) map.set(entry.path, entry)
    return map
  }, [dirs])

  const knownDirectories = useMemo(
    () =>
      [...entryByPath.values()].filter((entry) => entry.kind === 'dir').map((entry) => entry.path),
    [entryByPath]
  )

  // The rows currently on screen, in render order — the coordinate space for shift-ranges and "Select all".
  const visibleRows = useMemo(() => {
    const rows: FsEntryView[] = []
    const walk = (dir: string) => {
      for (const entry of dirs[dir] ?? []) {
        rows.push(entry)
        if (entry.kind === 'dir' && expanded.has(entry.path)) walk(entry.path)
      }
    }
    walk('')
    return rows
  }, [dirs, expanded])

  const targetsOf = useCallback(
    (paths: string[]): FsTarget[] =>
      pruneRedundantPaths(paths)
        .sort()
        .map((path) => ({ path, kind: entryByPath.get(path)?.kind ?? 'file' })),
    [entryByPath]
  )

  // Shift-click selects the whole range between the last-toggled row (the anchor) and the clicked one. The anchor
  // is tracked by path, so collapsing a folder mid-selection can't mis-range: if it left the visible rows, fall
  // back to a plain toggle.
  const anchorRef = useRef<string | null>(null)
  function toggleSelect(path: string, shiftKey: boolean) {
    const anchor = anchorRef.current
    if (shiftKey && anchor !== null && anchor !== path) {
      const from = visibleRows.findIndex((row) => row.path === anchor)
      const to = visibleRows.findIndex((row) => row.path === path)
      if (from !== -1 && to !== -1) {
        const [lo, hi] = from < to ? [from, to] : [to, from]
        const range = visibleRows.slice(lo, hi + 1).map((row) => row.path)
        setSelected((prev) => new Set([...prev, ...range]))
        anchorRef.current = path
        return
      }
    }
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
    anchorRef.current = path
  }

  const selectAllVisible = () => setSelected(new Set(visibleRows.map((row) => row.path)))

  // A deletion takes the entry's whole subtree, so drop everything it covered from the selection too.
  function applyRemovals(paths: string[]) {
    setSelected((prev) => {
      const next = new Set<string>()
      for (const path of prev) if (!paths.some((root) => coversPath(root, path))) next.add(path)
      return next
    })
    refreshAll()
    onRemoved?.(paths)
  }

  function applyMoves(moves: { from: string; to: string }[]) {
    setSelected((prev) => {
      const next = new Set<string>()
      for (const path of prev) {
        next.add(
          moves.reduce(
            (current, move) => rewriteMovedPath(current, move.from, move.to) ?? current,
            path
          )
        )
      }
      return next
    })
    refreshAll()
    for (const move of moves) onMoved?.(move.from, move.to)
  }

  async function runMoves(sources: string[], targetDir: string) {
    clearHoverExpand()
    setDropTarget(null)
    setDragPaths([])
    const movable = movablePaths(targetDir, sources)
    if (movable.length === 0) return
    setMoveError(undefined)
    setMoving(true)
    const res = await moveEntriesAction(
      movable.map((from) => ({ from, to: joinFsPath(targetDir, baseNameOf(from)) }))
    )
    setMoving(false)
    if (res.failed.length > 0) {
      setMoveError(res.failed.map((f) => `${displayPath(f.path)}: ${f.error}`).join(' · '))
    }
    if (res.moved.length === 0) return
    if (targetDir !== '') expandDir(targetDir) // reveal where it landed
    applyMoves(res.moved)
  }

  // What failed, in the uploader's terms — the two mendable cases get their own copy; the rest is the server's.
  const uploadFailureText = (failure: UploadFailure) =>
    failure.kind === 'tooLarge'
      ? t('uploadTooLarge')
      : failure.kind === 'exists'
        ? t('uploadExists')
        : (failure.error ?? '')

  async function runUploads(targetDir: string, files: File[]) {
    clearHoverExpand()
    setDropTarget(null)
    if (files.length === 0) return
    setUploadError(undefined)
    setUploadBusy(true)
    const res = await uploadFilesInto(targetDir, files)
    setUploadBusy(false)
    if (res.failed.length > 0) {
      setUploadError(res.failed.map((f) => `${f.name}: ${uploadFailureText(f)}`).join(' · '))
    }
    if (res.uploaded.length === 0) return
    if (targetDir !== '') expandDir(targetDir) // reveal where it landed
    refreshAll()
    // A single upload opens right away — "did it arrive?" is the next question, and the viewer answers it.
    const single = res.uploaded.length === 1 ? res.uploaded[0] : undefined
    if (single !== undefined) onOpenFile(single.path)
  }

  // Drop-target wiring, shared by folder rows (drop INTO that folder), file rows (drop into the folder the file
  // sits in) and the tree body (drop at the root). Rows stop propagation so the row under the cursor — not the
  // container it bubbles through — decides the target. Two payloads react: an in-tree drag moves entries, an
  // OS-file drag uploads into the same target the move would have used.
  function dropProps(targetDir: string, stop: boolean) {
    return {
      onDragOver: (e: DragEvent<HTMLElement>) => {
        if (!canWrite) return
        const internal = e.dataTransfer.types.includes(FS_DRAG_TYPE)
        const osFiles = !internal && e.dataTransfer.types.includes('Files')
        if (!internal && !osFiles) return
        if (stop) e.stopPropagation()
        if (internal && movablePaths(targetDir, dragPaths).length === 0) {
          setDropTarget(null)
          return // no preventDefault → the cursor shows "not allowed"
        }
        e.preventDefault()
        e.dataTransfer.dropEffect = internal ? 'move' : 'copy'
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
        if (!canWrite) return
        const internal = e.dataTransfer.types.includes(FS_DRAG_TYPE)
        const osFiles = !internal && e.dataTransfer.types.includes('Files')
        if (!internal && !osFiles) return
        e.preventDefault()
        if (stop) e.stopPropagation()
        if (osFiles) {
          void runUploads(targetDir, Array.from(e.dataTransfer.files))
          return
        }
        const sources = parseDragPaths(e.dataTransfer.getData(FS_DRAG_TYPE))
        if (movablePaths(targetDir, sources).length > 0) void runMoves(sources, targetDir)
        else {
          clearHoverExpand()
          setDropTarget(null)
          setDragPaths([])
        }
      },
    }
  }

  function dragProps(path: string) {
    if (!canWrite) return {}
    return {
      draggable: true,
      onDragStart: (e: DragEvent<HTMLElement>) => {
        // Dragging a checked row carries the entire selection; dragging an unchecked one carries only itself
        // and leaves the selection alone (Finder grammar).
        const paths = selected.has(path) ? pruneRedundantPaths([...selected]) : [path]
        e.dataTransfer.setData(FS_DRAG_TYPE, JSON.stringify(paths))
        e.dataTransfer.setData('text/plain', paths.map(displayPath).join('\n'))
        e.dataTransfer.effectAllowed = 'move'
        setMoveError(undefined)
        setDragPaths(paths)
      },
      onDragEnd: () => {
        clearHoverExpand()
        setDragPaths([])
        setDropTarget(null)
      },
    }
  }

  function renderRow(entry: FsEntryView, dir: string, depth: number) {
    const isDir = entry.kind === 'dir'
    const isChecked = selected.has(entry.path)
    return (
      // The row is a plain container, not a button: the name, the checkbox and the trash are three separate
      // controls (nesting them inside one button would be invalid), and the container carries the drag/drop.
      <div
        {...dragProps(entry.path)}
        {...dropProps(isDir ? entry.path : dir, true)}
        className={cn(
          'group flex items-center rounded-md pr-1 transition-colors',
          isChecked ? 'bg-primary/[0.07]' : 'hover:bg-accent',
          isDir && dropTarget === entry.path && 'bg-primary/10 ring-1 ring-primary/50',
          dragPaths.includes(entry.path) && 'opacity-50',
          !isDir && selectedPath === entry.path && !isChecked && 'bg-accent'
        )}
        style={{ paddingLeft: depth * 14 + 4 }}
      >
        {canWrite && (
          <button
            type="button"
            role="checkbox"
            aria-checked={isChecked}
            aria-label={t('selectAria', { name: entry.name })}
            onClick={(e) => toggleSelect(entry.path, e.shiftKey)}
            className={cn(
              'grid size-5 shrink-0 place-items-center rounded outline-none transition-opacity hover:bg-accent/60 focus-visible:opacity-100',
              isChecked || selectionMode ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
            )}
          >
            <span
              className={cn(
                'grid size-[14px] place-items-center rounded-[3px] border transition-colors',
                isChecked
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border-strong bg-card'
              )}
            >
              {isChecked && <Check className="size-2.5" strokeWidth={3} />}
            </span>
          </button>
        )}
        <button
          type="button"
          onClick={(e) => {
            // In selection mode a row click toggles instead of opening — a stray click must not swap the
            // viewer's document out from under a selection in progress (scorecard-list grammar). Folders
            // always expand: reaching a nested row is how you extend the selection.
            if (isDir) void toggleDir(entry.path)
            else if (selectionMode && canWrite) toggleSelect(entry.path, e.shiftKey)
            else onOpenFile(entry.path)
          }}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-1.5 py-1 pl-1 text-left text-[12.5px]',
            selectionMode && 'select-none', // shift-range clicks must not highlight row text
            isDir || selectedPath === entry.path ? 'text-foreground' : 'text-muted-foreground'
          )}
        >
          {isDir ? (
            expanded.has(entry.path) ? (
              <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
            )
          ) : (
            <span className="w-3.5 shrink-0" /> // keeps file names aligned with folder names
          )}
          {isDir ? (
            <Folder className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <FileIcon className="size-3.5 shrink-0" />
          )}
          <span className="truncate">{entry.name}</span>
          {/* Trailing meta — when the file was last written, then its size. Relative time answers "is this
              fresh?" at a glance; the exact stamp is the title. Both are container-queried off the TREE's
              width, and mtime outranks size: a split view narrows the tree to ~190px, where the freshness
              signal earns the room and the byte count steps aside. */}
          {!isDir && (
            <span className="ml-auto flex shrink-0 items-center gap-2 pl-2 text-[11px] text-muted-foreground/70">
              {entry.modifiedAt !== undefined && (
                <span
                  className="hidden @[12rem]:inline"
                  title={fmtDateTimeFull(entry.modifiedAt, { locale, timeZone })}
                >
                  {fmtTimeAgo(entry.modifiedAt, locale, timeZone)}
                </span>
              )}
              {entry.size !== undefined && (
                <span className="hidden @[18rem]:inline">{fmtBytes(entry.size)}</span>
              )}
            </span>
          )}
        </button>
        {/* Hover-revealed row trash — deleting is a LIST action (the viewer has none), and the single-entry
            case shouldn't require checking a box first. A fixed slot keeps every row's meta aligned. */}
        {canWrite && (
          <button
            type="button"
            aria-label={t('deleteEntryAria', { name: entry.name })}
            title={t('delete')}
            onClick={() => setBulk({ kind: 'delete', targets: targetsOf([entry.path]) })}
            className="grid size-6 shrink-0 place-items-center rounded text-faint opacity-0 transition hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
          >
            <Trash2 className="size-3.5" />
          </button>
        )}
      </div>
    )
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
        {renderRow(entry, dir, depth)}
        {entry.kind === 'dir' && expanded.has(entry.path) && renderTree(entry.path, depth + 1)}
      </div>
    ))
  }

  // Keep the floating action bar over the content region rather than the raw viewport: the bar is portaled to
  // <body> and `fixed`, so `inset-x-0` would center it across the whole screen — with the infra split panel open
  // it would slide under the panel, and in the workbench it would drift away from the 300px tree column.
  // Measuring the enclosing <main> (which reflows when the panel takes/releases its flex share) tracks both.
  const rootRef = useRef<HTMLDivElement>(null)
  const [barBox, setBarBox] = useState<{ left: number; width: number } | null>(null)
  useEffect(() => {
    const el = rootRef.current
    if (!el || !selectionMode) return
    const region = el.closest('main') ?? el
    const measure = () => {
      const rect = region.getBoundingClientRect()
      setBarBox({ left: rect.left, width: rect.width })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(region)
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [selectionMode])

  return (
    <div ref={rootRef} className="rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-2.5 py-1.5">
        <span className="flex items-center gap-1.5 px-1 text-[13px] font-[510] text-foreground">
          {t('treeTitle')}
          {(moving || uploadBusy) && (
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
          )}
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
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('upload')}
                title={t('upload')}
                onClick={() => uploadInput.current?.click()}
              >
                <Upload />
              </Button>
              {/* The picker uploads to the root; a targeted upload is dropping the files onto a folder row. */}
              <input
                ref={uploadInput}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  const files = Array.from(e.currentTarget.files ?? [])
                  e.currentTarget.value = '' // picking the same file again must still fire change
                  void runUploads('', files)
                }}
              />
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
          // @container: the row meta sizes off the TREE's width, not the viewport — the same tree renders
          // full-width in Settings › Files and in a 300px workbench column (see detail-view container rule).
          '@container max-h-[480px] overflow-y-auto p-1.5',
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
      {uploadError !== undefined && (
        <div className="border-t border-border px-3 py-2 text-[11.5px] text-destructive">
          {t('uploadFailed')} — {uploadError}
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

      {/* Floating action bar — appears while anything is checked (scorecard-list grammar) and fans the action
          out over the selection. Portaled to <body>: the page-transition wrapper animates transform, and a
          transformed ancestor becomes the containing block for `fixed`, which would pin the bar to the bottom
          of the page content instead of the viewport. */}
      {selectionMode &&
        createPortal(
          <div
            className="fixed bottom-6 z-30 flex justify-center px-4"
            style={barBox ? { left: barBox.left, width: barBox.width } : { left: 0, right: 0 }}
          >
            <div className="flex items-center gap-1 rounded-xl border border-border bg-card/95 px-2.5 py-2 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-card/80">
              <span className="px-1.5 text-[12.5px] font-[510] tabular-nums text-foreground">
                {t('selectedCount', { count: selected.size })}
              </span>
              <span className="mx-1 h-4 w-px bg-border" />
              <button
                type="button"
                onClick={selectAllVisible}
                className="rounded-md px-2 py-1 text-[12.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                {t('selectAllVisible')}
              </button>
              <button
                type="button"
                onClick={() => setSelected(new Set())}
                className="rounded-md px-2 py-1 text-[12.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                {t('clearSelection')}
              </button>
              <Button
                variant="outline"
                size="sm"
                className="ml-1"
                onClick={() => setBulk({ kind: 'move', targets: targetsOf([...selected]) })}
              >
                <CornerDownRight className="size-3.5" />
                {t('moveSelected')}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setBulk({ kind: 'delete', targets: targetsOf([...selected]) })}
              >
                <Trash2 className="size-3.5" />
                {t('deleteSelected')}
              </Button>
            </div>
          </div>,
          document.body
        )}

      {bulk?.kind === 'delete' && (
        <DeleteEntriesDialog
          targets={bulk.targets}
          onClose={() => setBulk(null)}
          onDeleted={applyRemovals}
        />
      )}
      {bulk?.kind === 'move' && (
        <MoveEntriesDialog
          sources={bulk.targets}
          directories={knownDirectories}
          onClose={() => setBulk(null)}
          onMoved={(moves) => {
            applyMoves(moves)
            const destination = parentOf(moves[0]?.to ?? '')
            if (destination !== '') expandDir(destination)
          }}
        />
      )}
    </div>
  )
}
