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
  Pencil,
  RefreshCw,
  Save,
  Trash2,
  X,
} from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { FsEntryView, FsFileContentView } from '@/entities/workspace-file'
import { fmtBytes, fmtDateTime } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { CodeEditor } from '@/shared/ui/code-editor'
import { Dialog } from '@/shared/ui/dialog'
import { EmptyState } from '@/shared/ui/empty-state'
import { Input, Label } from '@/shared/ui/input'
import { Markdown } from '@/shared/ui/markdown'

import {
  listFilesAction,
  makeDirectoryAction,
  moveEntryAction,
  readFileAction,
  removeEntryAction,
  writeFileAction,
} from '../api/browse-files'
import { displayPath, isMarkdownPath, languageFor } from '../lib/fs-path'
import { FileShell } from './file-shell'

// The Files workbench — tree (lazy per-directory loading) + viewer/editor + the bash-style shell, all sharing one
// directory cache so a shell mutation refreshes the tree. Read-only for viewers; members write (control-plane
// enforced; the UI pre-gates for honest affordances).

type DirCache = Record<string, FsEntryView[]>

type DialogMode =
  | { kind: 'new-file' }
  | { kind: 'new-folder' }
  | { kind: 'move'; from: string }
  | null

export function FilesWorkbench({
  initialEntries,
  canWrite,
  refreshToken,
  onMutated,
}: {
  initialEntries: FsEntryView[]
  canWrite: boolean
  refreshToken?: number // bump from outside (e.g. the Settings governance rows) to refetch the tree
  onMutated?: () => void // fired after every refresh sweep so a host view can refresh its own data (usage)
}) {
  const t = useTranslations('files')
  const [dirs, setDirs] = useState<DirCache>({ '': initialEntries })
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selectedPath, setSelectedPath] = useState<string | undefined>(undefined)
  const [file, setFile] = useState<FsFileContentView | undefined>(undefined)
  const [fileError, setFileError] = useState<string | undefined>(undefined)
  const [loadingFile, setLoadingFile] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [mdRaw, setMdRaw] = useState(false)
  const [dialog, setDialog] = useState<DialogMode>(null)
  const [dialogPath, setDialogPath] = useState('')
  const [dialogError, setDialogError] = useState<string | undefined>(undefined)
  const [dialogBusy, setDialogBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const loadDir = useCallback(async (path: string) => {
    const res = await listFilesAction(path)
    if (res.ok && res.data) setDirs((prev) => ({ ...prev, [path]: res.data ?? [] }))
    return res
  }, [])

  // One refresh for every mutation source (toolbar, viewer actions, shell): refetch the root and every expanded dir.
  const refreshAll = useCallback(() => {
    void loadDir('')
    for (const dir of expanded) void loadDir(dir)
    onMutated?.()
  }, [expanded, loadDir, onMutated])

  async function toggleDir(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
    if (!(path in dirs)) await loadDir(path)
  }

  const openFile = useCallback(async (path: string) => {
    setSelectedPath(path)
    setEditing(false)
    setMdRaw(false)
    setFileError(undefined)
    setLoadingFile(true)
    const res = await readFileAction(path)
    setLoadingFile(false)
    if (res.ok && res.data) setFile(res.data)
    else {
      setFile(undefined)
      setFileError(res.error)
    }
  }, [])

  // An outside mutation (Settings governance rows) bumps refreshToken → refetch the tree in place.
  // Deliberately keyed on the token alone — refreshAll identity churn must not re-trigger the sweep.
  useEffect(() => {
    if (refreshToken !== undefined && refreshToken > 0) refreshAll()
  }, [refreshToken])

  async function saveDraft() {
    if (selectedPath === undefined) return
    setSaving(true)
    const res = await writeFileAction({ path: selectedPath, content: draft })
    setSaving(false)
    if (res.ok) {
      setEditing(false)
      await openFile(selectedPath)
      refreshAll()
    } else {
      setFileError(res.error)
    }
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
        : dialog.kind === 'new-folder'
          ? await makeDirectoryAction(path)
          : await moveEntryAction(dialog.from, path)
    setDialogBusy(false)
    if (!res.ok) {
      setDialogError(res.error)
      return
    }
    setDialog(null)
    refreshAll()
    if (dialog.kind === 'new-file') await openFile(path)
    if (dialog.kind === 'move') {
      if (selectedPath === dialog.from) await openFile(path)
    }
  }

  async function deleteSelected() {
    if (selectedPath === undefined) return
    const res = await removeEntryAction(selectedPath, false)
    setConfirmDelete(false)
    if (res.ok) {
      setSelectedPath(undefined)
      setFile(undefined)
      refreshAll()
    } else {
      setFileError(res.error)
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
            onClick={() => void openFile(entry.path)}
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

  const isImage =
    file?.entry.contentType?.startsWith('image/') === true && file.encoding === 'base64'
  const isText = file?.encoding === 'utf8'
  const markdown = selectedPath !== undefined && isMarkdownPath(selectedPath)

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
        {/* tree pane */}
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
        </div>

        {/* viewer pane */}
        <div className="min-w-0 rounded-lg border border-border bg-card">
          {selectedPath === undefined ? (
            <div className="flex h-full min-h-[320px] items-center justify-center">
              <EmptyState title={t('selectFile')} icon={<FileIcon />} />
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2 border-b border-border px-3.5 py-2">
                <span className="min-w-0 truncate font-mono text-[12.5px] text-foreground">
                  {displayPath(selectedPath)}
                </span>
                {file?.entry.modifiedAt !== undefined && (
                  <span className="hidden text-[11.5px] text-muted-foreground md:block">
                    {fmtDateTime(file.entry.modifiedAt)}
                  </span>
                )}
                <div className="ml-auto flex items-center gap-1">
                  {markdown && isText && !editing && (
                    <Button variant="ghost" size="xs" onClick={() => setMdRaw((v) => !v)}>
                      {mdRaw ? t('preview') : t('raw')}
                    </Button>
                  )}
                  {canWrite && isText && !editing && (
                    <Button
                      variant="outline"
                      size="xs"
                      onClick={() => {
                        setDraft(file?.content ?? '')
                        setEditing(true)
                      }}
                    >
                      <Pencil /> {t('edit')}
                    </Button>
                  )}
                  {editing && (
                    <>
                      <Button
                        variant="primary"
                        size="xs"
                        disabled={saving}
                        onClick={() => void saveDraft()}
                      >
                        <Save /> {saving ? t('saving') : t('save')}
                      </Button>
                      <Button variant="ghost" size="xs" onClick={() => setEditing(false)}>
                        <X /> {t('cancel')}
                      </Button>
                    </>
                  )}
                  {canWrite && !editing && (
                    <>
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => {
                          if (selectedPath === undefined) return
                          setDialog({ kind: 'move', from: selectedPath })
                          setDialogPath(selectedPath)
                          setDialogError(undefined)
                        }}
                      >
                        {t('move')}
                      </Button>
                      <Button variant="ghost" size="xs" onClick={() => setConfirmDelete(true)}>
                        <Trash2 /> {t('delete')}
                      </Button>
                    </>
                  )}
                </div>
              </div>
              <div className="min-h-[280px] p-3.5">
                {loadingFile ? (
                  <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" />
                  </div>
                ) : fileError !== undefined ? (
                  <EmptyState title={t('loadError')} hint={fileError} />
                ) : editing ? (
                  <CodeEditor
                    value={draft}
                    onChange={setDraft}
                    language={languageFor(selectedPath)}
                    minHeight="320px"
                    aria-label={selectedPath}
                  />
                ) : file === undefined ? null : isImage ? (
                  // eslint-disable-next-line @next/next/no-img-element -- data URI preview, no next/image benefit
                  <img
                    src={`data:${file.entry.contentType ?? 'image/png'};base64,${file.content}`}
                    alt={file.entry.name}
                    className="max-h-[480px] max-w-full rounded-md border border-border"
                  />
                ) : !isText ? (
                  <EmptyState
                    title={t('binaryFile')}
                    hint={file.entry.size !== undefined ? fmtBytes(file.entry.size) : undefined}
                  />
                ) : markdown && !mdRaw ? (
                  <Markdown content={file.content} className="max-w-none" />
                ) : (
                  <CodeEditor
                    value={file.content}
                    language={languageFor(selectedPath)}
                    minHeight="320px"
                    readOnly
                    aria-label={selectedPath}
                  />
                )}
              </div>
            </>
          )}
        </div>
      </div>

      <FileShell canWrite={canWrite} onMutated={refreshAll} />

      {/* path dialog: new file / new folder / move */}
      <Dialog open={dialog !== null} onClose={() => setDialog(null)} className="max-w-md">
        <div className="space-y-3 p-4">
          <p className="text-[13.5px] font-[510] text-foreground">
            {dialog?.kind === 'new-file'
              ? t('newFile')
              : dialog?.kind === 'new-folder'
                ? t('newFolder')
                : t('move')}
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
              {dialog?.kind === 'move' ? t('move') : t('create')}
            </Button>
          </div>
        </div>
      </Dialog>

      {/* delete confirm */}
      <Dialog open={confirmDelete} onClose={() => setConfirmDelete(false)} className="max-w-sm">
        <div className="space-y-3 p-4">
          <p className="text-[13.5px] font-[510] text-foreground">
            {t('deleteTitle', {
              path: selectedPath !== undefined ? displayPath(selectedPath) : '',
            })}
          </p>
          <p className="text-[12.5px] text-muted-foreground">{t('deleteFileBody')}</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
              {t('cancel')}
            </Button>
            <Button variant="destructive" size="sm" onClick={() => void deleteSelected()}>
              {t('delete')}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  )
}
