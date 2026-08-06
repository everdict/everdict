'use client'

import { useCallback, useEffect, useState } from 'react'
import { Check, ChevronDown, Download, History, Loader2, Pencil, Play, Save, X } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type {
  FileExecutionResultView,
  FsFileContentView,
  FsWriteConflictView,
} from '@/entities/workspace-file'
import { fmtDateTime } from '@/shared/lib/format'
import { Button } from '@/shared/ui/button'
import { CodeEditor } from '@/shared/ui/code-editor'
import { DropdownItem, DropdownLabel, DropdownMenu } from '@/shared/ui/dropdown-menu'
import { EmptyState } from '@/shared/ui/empty-state'

import {
  listRunTargetsAction,
  readFileAction,
  runFileAction,
  writeFileAction,
} from '../api/browse-files'
import { downloadBlob, fileBlob } from '../lib/file-bytes'
import { isRunnablePath, languageFor, previewKindFor, supportsRawView } from '../lib/file-kind'
import { displayPath } from '../lib/fs-path'
import { DocumentPreview } from './document-preview'
import { ExecutionOutput } from './execution-output'
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
  canRun = false,
  onMutated,
}: {
  path: string
  canWrite: boolean
  canRun?: boolean // the deployment can run a file AND the member may write — see GET /me config.fileExecution
  onMutated?: () => void // fired after a save (or a run that produced files) so the host can refresh its tree
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
  // The last run of this file. Cleared when the document changes — an output pane for a file you are no longer
  // looking at is worse than no output pane.
  const [running, setRunning] = useState(false)
  const [execution, setExecution] = useState<FileExecutionResultView | undefined>(undefined)
  // WHERE it runs. undefined = the deployment's own compute; a name = one of the workspace's registered
  // runtimes, so the script executes on their cluster inside their trust zone. Kept across files on purpose —
  // "run my scripts over there" is a standing preference, not a per-document one.
  const [target, setTarget] = useState<string | undefined>(undefined)
  const [targets, setTargets] = useState<{ id: string }[] | undefined>(undefined)

  const load = useCallback(async () => {
    setEditing(false)
    setShowRaw(false)
    setExecution(undefined)
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

  // Run it. The whole execution happens server-side inside this call, so the button stays busy until the
  // sandbox is gone. A run that produced files changed the tree — tell the host so it refetches.
  async function runFile() {
    setRunning(true)
    const res = await runFileAction(path, target !== undefined ? { runtime: target } : undefined)
    setRunning(false)
    if (res.ok && res.data) {
      setExecution(res.data)
      if (res.data.outputs.some((output) => output.skipped !== true)) onMutated?.()
    } else {
      setFileError(res.error)
    }
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
          {canRun && isRunnablePath(path) && isText && !editing && !showHistory && (
            <span className="inline-flex items-center">
              <Button
                variant="outline"
                size="xs"
                disabled={running}
                className="rounded-r-none border-r-0"
                onClick={() => void runFile()}
              >
                {running ? <Loader2 className="animate-spin" /> : <Play />}{' '}
                {running ? t('running') : (target ?? t('run'))}
              </Button>
              <DropdownMenu
                align="end"
                trigger={({ toggle }) => (
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={running}
                    className="rounded-l-none px-1.5"
                    title={t('runOn')}
                    aria-label={t('runOn')}
                    onClick={() => {
                      // Fetched on first open, not on every file — the list only matters once someone asks.
                      if (targets === undefined) void listRunTargetsAction().then(setTargets)
                      toggle()
                    }}
                  >
                    <ChevronDown />
                  </Button>
                )}
              >
                <DropdownLabel>{t('runOn')}</DropdownLabel>
                <DropdownItem
                  onSelect={() => setTarget(undefined)}
                  trailing={target === undefined ? <Check /> : undefined}
                >
                  {t('runHere')}
                </DropdownItem>
                {(targets ?? []).map((r) => (
                  <DropdownItem
                    key={r.id}
                    onSelect={() => setTarget(r.id)}
                    trailing={target === r.id ? <Check /> : undefined}
                  >
                    {r.id}
                  </DropdownItem>
                ))}
              </DropdownMenu>
            </span>
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
          {execution !== undefined && !editing && <ExecutionOutput result={execution} />}
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
