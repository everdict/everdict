'use client'

import { useCallback, useEffect, useState } from 'react'
import { Download, History, Loader2, Pencil, Save, X } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { FsFileContentView, FsWriteConflictView } from '@/entities/workspace-file'
import { fmtDateTime } from '@/shared/lib/format'
import { Button } from '@/shared/ui/button'
import { CodeEditor } from '@/shared/ui/code-editor'
import { EmptyState } from '@/shared/ui/empty-state'

import { readFileAction, writeFileAction } from '../api/browse-files'
import { downloadBlob, fileBlob } from '../lib/file-bytes'
import { languageFor, previewKindFor, supportsRawView } from '../lib/file-kind'
import { displayPath } from '../lib/fs-path'
import { DocumentPreview } from './document-preview'
import { FileHistory } from './file-history'
import { MergeConflictDialog } from './merge-conflict-dialog'

// One rendered file — header (path · mtime · raw/download/edit/history) + content, self-loading by path. WHAT a
// document looks like is `DocumentPreview`'s job; this owns the chrome and the edit/publish cycle. Shared by the
// Files workbench's right pane and the infra panel's file tab, so both surfaces render a selection identically.
// Style-agnostic: the host owns the frame (card border / panel scroll). Neither relocation NOR deletion is here
// (user decision): both are LIST actions in the tree, which owns the folder context and the multi-select — the
// viewer only reads and edits the one open document.
export function FileViewer({
  path,
  canWrite,
  onMutated,
}: {
  path: string
  canWrite: boolean
  onMutated?: () => void // fired after a save so the host can refresh its tree
}) {
  const t = useTranslations('files')
  const [file, setFile] = useState<FsFileContentView | undefined>(undefined)
  const [fileError, setFileError] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [showRaw, setShowRaw] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  // A save refused because someone published first — held here so the resolution dialog can offer the merge.
  const [conflict, setConflict] = useState<FsWriteConflictView | undefined>(undefined)

  const load = useCallback(async () => {
    setEditing(false)
    setShowRaw(false)
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

  // Publishing declares WHICH revision was edited, so a teammate's or an agent's publish in the meantime is
  // caught instead of overwritten: the refusal comes back with the live content and an attempted merge, which
  // the dialog turns into a one-click resolution.
  async function publish(content: string, baseRevision: number | undefined) {
    setSaving(true)
    const res = await writeFileAction({
      path,
      content,
      ...(baseRevision !== undefined ? { baseRevision } : {}),
    })
    setSaving(false)
    if (res.ok) {
      setConflict(undefined)
      setEditing(false)
      await load()
      onMutated?.()
      return
    }
    if (res.conflict) {
      setDraft(content) // keep what the author wrote — the dialog offers it as "keep mine"
      setConflict(res.conflict)
      return
    }
    setFileError(res.error)
  }

  // A brand-new file has no revision yet; base 0 states that expectation, so two people creating the same path
  // at once is caught too.
  const saveDraft = () => publish(draft, file?.entry.revision ?? 0)

  // Everything the browser cannot render inline — an .xlsx, a .zip, a model checkpoint — is still the user's
  // file, so it always leaves by the same door.
  function download() {
    if (file === undefined) return
    downloadBlob(file.entry.name, fileBlob(file.content, file.encoding, file.entry.contentType))
  }

  const isText = file?.encoding === 'utf8'
  const canToggleRaw =
    file !== undefined &&
    supportsRawView(previewKindFor(path, file.entry.contentType, file.encoding), file.encoding)

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
          {!editing && (
            <Button
              variant={showHistory ? 'outline' : 'ghost'}
              size="xs"
              onClick={() => setShowHistory((v) => !v)}
              title={t('history')}
            >
              <History /> {t('history')}
            </Button>
          )}
          {canToggleRaw && !editing && !showHistory && (
            <Button variant="ghost" size="xs" onClick={() => setShowRaw((v) => !v)}>
              {showRaw ? t('preview') : t('raw')}
            </Button>
          )}
          {file !== undefined && !editing && !showHistory && (
            <Button variant="ghost" size="xs" onClick={download} title={t('download')}>
              <Download /> {t('download')}
            </Button>
          )}
          {canWrite && isText && !editing && !showHistory && (
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
        </div>
      </div>
      {showHistory ? (
        <FileHistory
          path={path}
          canWrite={canWrite}
          {...(file?.entry.revision !== undefined ? { currentRevision: file.entry.revision } : {})}
          onRestored={() => {
            void load()
            onMutated?.()
          }}
        />
      ) : (
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
          ) : file === undefined ? null : (
            <DocumentPreview file={file} path={path} raw={showRaw} />
          )}
        </div>
      )}
      {conflict !== undefined && (
        <MergeConflictDialog
          conflict={conflict}
          path={path}
          mine={draft}
          publishing={saving}
          onPublish={(content, baseRevision) => void publish(content, baseRevision)}
          onClose={() => setConflict(undefined)}
        />
      )}
    </>
  )
}
