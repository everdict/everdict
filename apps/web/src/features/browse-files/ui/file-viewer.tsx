'use client'

import { useCallback, useEffect, useState } from 'react'
import { Loader2, Pencil, Save, Trash2, X } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { FsFileContentView } from '@/entities/workspace-file'
import { fmtBytes, fmtDateTime } from '@/shared/lib/format'
import { Button } from '@/shared/ui/button'
import { CodeEditor } from '@/shared/ui/code-editor'
import { Dialog } from '@/shared/ui/dialog'
import { EmptyState } from '@/shared/ui/empty-state'
import { Markdown } from '@/shared/ui/markdown'

import { readFileAction, removeEntryAction, writeFileAction } from '../api/browse-files'
import { displayPath, isMarkdownPath, languageFor } from '../lib/fs-path'

// One rendered file — header (path · mtime · preview/edit/delete) + content (Markdown preview, code, image,
// binary notice), self-loading by path. Shared by the Files workbench's right pane and the infra panel's file
// tab, so both surfaces render a selection identically. Style-agnostic: the host owns the frame (card border /
// panel scroll); selection bookkeeping stays with the host via onDeleted/onMutated. Relocation is NOT here —
// moving a file is drag-and-drop in the tree (user decision), which is also where the folder context lives.
export function FileViewer({
  path,
  canWrite,
  onMutated,
  onDeleted,
}: {
  path: string
  canWrite: boolean
  onMutated?: () => void // fired after any mutation (save / delete) so the host can refresh its tree
  onDeleted?: () => void // the host clears its selection
}) {
  const t = useTranslations('files')
  const [file, setFile] = useState<FsFileContentView | undefined>(undefined)
  const [fileError, setFileError] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [mdRaw, setMdRaw] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const load = useCallback(async () => {
    setEditing(false)
    setMdRaw(false)
    setFileError(undefined)
    setLoading(true)
    const res = await readFileAction(path)
    setLoading(false)
    if (res.ok && res.data) setFile(res.data)
    else {
      setFile(undefined)
      setFileError(res.error)
    }
  }, [path])

  useEffect(() => {
    void load()
  }, [load])

  async function saveDraft() {
    setSaving(true)
    const res = await writeFileAction({ path, content: draft })
    setSaving(false)
    if (res.ok) {
      setEditing(false)
      await load()
      onMutated?.()
    } else {
      setFileError(res.error)
    }
  }

  async function deleteFile() {
    const res = await removeEntryAction(path, false)
    setConfirmDelete(false)
    if (res.ok) {
      onMutated?.()
      onDeleted?.()
    } else {
      setFileError(res.error)
    }
  }

  const isImage =
    file?.entry.contentType?.startsWith('image/') === true && file.encoding === 'base64'
  const isText = file?.encoding === 'utf8'
  const markdown = isMarkdownPath(path)

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3.5 py-2">
        <span className="min-w-0 truncate font-mono text-[12.5px] text-foreground">
          {displayPath(path)}
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
              <Button variant="primary" size="xs" disabled={saving} onClick={() => void saveDraft()}>
                <Save /> {saving ? t('saving') : t('save')}
              </Button>
              <Button variant="ghost" size="xs" onClick={() => setEditing(false)}>
                <X /> {t('cancel')}
              </Button>
            </>
          )}
          {canWrite && !editing && (
            <Button variant="ghost" size="xs" onClick={() => setConfirmDelete(true)}>
              <Trash2 /> {t('delete')}
            </Button>
          )}
        </div>
      </div>
      <div className="min-h-[280px] p-3.5">
        {loading ? (
          <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
          </div>
        ) : fileError !== undefined ? (
          <EmptyState title={t('loadError')} hint={fileError} />
        ) : editing ? (
          <CodeEditor
            value={draft}
            onChange={setDraft}
            language={languageFor(path)}
            minHeight="320px"
            aria-label={path}
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
            language={languageFor(path)}
            minHeight="320px"
            readOnly
            aria-label={path}
          />
        )}
      </div>

      {/* delete confirm */}
      <Dialog open={confirmDelete} onClose={() => setConfirmDelete(false)} className="max-w-sm">
        <div className="space-y-3 p-4">
          <p className="text-[13.5px] font-[510] text-foreground">
            {t('deleteTitle', { path: displayPath(path) })}
          </p>
          <p className="text-[12.5px] text-muted-foreground">{t('deleteFileBody')}</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
              {t('cancel')}
            </Button>
            <Button variant="destructive" size="sm" onClick={() => void deleteFile()}>
              {t('delete')}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  )
}
