'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'

import { useRunLiveStream } from '@/entities/run'
import { languageFor } from '@/features/browse-files'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { CodeEditor } from '@/shared/ui/code-editor'

const TERMINAL = new Set(['succeeded', 'failed', 'superseded'])
const POLL_MS = 4000

type FsStatus = 'modified' | 'added' | 'deleted'
type FsEntry = { path: string; status?: FsStatus }
type FsResponse = { status?: string; found: boolean; files: FsEntry[]; truncated: boolean }
type FsFileResponse = {
  found: boolean
  path: string
  size: number
  binary: boolean
  truncated: boolean
  content: string
  diff: string
}

// The one-letter status badge — the same colour grammar as VS Code's convention (M/A/D).
const STATUS_BADGE: Record<FsStatus, { letter: string; className: string }> = {
  modified: { letter: 'M', className: 'text-amber-500' },
  added: { letter: 'A', className: 'text-emerald-500' },
  deleted: { letter: 'D', className: 'text-red-500' },
}

// A sorted flat path list → a nested tree. Directories first, then files (each by name) — a file explorer's standard order.
type DirNode = { name: string; path: string; dirs: DirNode[]; files: FsEntry[] }
function buildTree(entries: FsEntry[]): DirNode {
  const root: DirNode = { name: '', path: '', dirs: [], files: [] }
  for (const entry of entries) {
    const segments = entry.path.split('/')
    let node = root
    for (let i = 0; i < segments.length - 1; i += 1) {
      const dirPath = segments.slice(0, i + 1).join('/')
      let next = node.dirs.find((d) => d.path === dirPath)
      if (!next) {
        next = { name: segments[i] ?? '', path: dirPath, dirs: [], files: [] }
        node.dirs.push(next)
      }
      node = next
    }
    node.files.push(entry)
  }
  return root
}

// The set of directories containing a changed file — it decides the default expansion of any directory the user has not touched
// (a branch with changes opens automatically, and a user closing it wins from then on).
function dirsWithChanges(entries: FsEntry[]): Set<string> {
  const dirty = new Set<string>()
  for (const entry of entries) {
    if (!entry.status) continue
    const segments = entry.path.split('/')
    for (let i = 1; i < segments.length; i += 1) dirty.add(segments.slice(0, i).join('/'))
  }
  return dirty
}

// The live repo workbench of a running case's sandbox — a file explorer on the left (with git status badges) and a read-only editor/diff on
// the right. It polls the tree every 4s, and with "follow" on it opens whatever file the agent just changed. On a sandbox with no repo
// (found=false) it renders nothing, and after the run ends it leaves the last state as it is (the exec channel closes).
export function RunFileWorkbench({ runId, initialStatus }: { runId: string; initialStatus?: string }) {
  const t = useTranslations('runWorkbench')
  const [files, setFiles] = useState<FsEntry[] | undefined>(undefined)
  const [treeTruncated, setTreeTruncated] = useState(false)
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const [file, setFile] = useState<FsFileResponse | undefined>(undefined)
  const [view, setView] = useState<'file' | 'diff'>('file')
  const [follow, setFollow] = useState(true)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const prevStatus = useRef<Map<string, FsStatus | undefined>>(new Map())
  const fileSeq = useRef(0)
  // The multiplexed stream (④): with the fs lane attached the tree arrives by server push — the 4s poll lives on only as the fallback.
  const stream = useRunLiveStream()
  const followRef = useRef(follow)
  followRef.current = follow
  const selectedRef = useRef(selected)
  selectedRef.current = selected

  // Loading one file — polling and clicks race, so a sequence number discards a stale response.
  const openFile = async (path: string, fromFollow: boolean) => {
    const seq = (fileSeq.current += 1)
    try {
      const res = await fetch(
        `/api/runs/${encodeURIComponent(runId)}/fs/file?path=${encodeURIComponent(path)}`
      )
      if (!res.ok) return
      const body = (await res.json()) as FsFileResponse
      if (seq !== fileSeq.current) return
      setFile(body)
      // Opened by follow and there is a diff → show "what changed" first; a direct click starts from the file content.
      setView(fromFollow && body.diff !== '' ? 'diff' : 'file')
    } catch {
      // transient — the next poll fills it again
    }
  }

  useEffect(() => {
    if (initialStatus && TERMINAL.has(initialStatus)) return
    if (stream?.connected) return // polling rests while the stream pushes the tree
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      try {
        const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/fs`)
        if (res.ok) {
          const body = (await res.json()) as FsResponse
          if (stopped) return
          if (body.found) {
            setFiles(body.files)
            setTreeTruncated(body.truncated)
            // A file whose status just changed → the follow target. A deletion has nothing to open, so it is skipped.
            const changed = body.files.find(
              (f) => f.status && f.status !== 'deleted' && prevStatus.current.get(f.path) !== f.status
            )
            prevStatus.current = new Map(body.files.map((f) => [f.path, f.status]))
            const current = selectedRef.current
            if (followRef.current && changed && changed.path !== current) {
              selectedRef.current = changed.path
              setSelected(changed.path)
              void openFile(changed.path, true)
            } else if (current && body.files.find((f) => f.path === current)?.status) {
              // If the open file is still being dirtied, refresh its content too.
              void openFile(current, false)
            }
          }
          if (body.status && TERMINAL.has(body.status)) return // the run ended — keep the last state
        }
      } catch {
        // transient — keep polling
      }
      if (!stopped) timer = setTimeout(tick, POLL_MS)
    }
    void tick()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
    // openFile is ref-based and therefore stable — the polling loop is tied to the runId lifecycle alone.
  }, [runId, initialStatus, stream?.connected])

  // The stream path — the same application rules (follow detection, refreshing the open file) applied to pushed data.
  useEffect(() => {
    if (!stream?.connected || !stream.fsFiles) return
    const pushed = stream.fsFiles
    setFiles(pushed)
    setTreeTruncated(stream.fsTruncated ?? false)
    const changed = pushed.find(
      (f) => f.status && f.status !== 'deleted' && prevStatus.current.get(f.path) !== f.status
    )
    prevStatus.current = new Map(pushed.map((f) => [f.path, f.status]))
    const current = selectedRef.current
    if (followRef.current && changed && changed.path !== current) {
      selectedRef.current = changed.path
      setSelected(changed.path)
      void openFile(changed.path, true)
    } else if (current && pushed.find((f) => f.path === current)?.status) {
      void openFile(current, false)
    }
  }, [stream?.connected, stream?.fsFiles, stream?.fsTruncated])

  const tree = useMemo(() => (files ? buildTree(files) : undefined), [files])
  const dirtyDirs = useMemo(() => (files ? dirsWithChanges(files) : new Set<string>()), [files])
  const changedCount = useMemo(() => files?.filter((f) => f.status).length ?? 0, [files])

  // A run where a repo was never found (a browser or OS case, etc.) — hidden whole rather than shown as an empty box.
  if (!tree || !files) return null

  const isCollapsed = (dirPath: string) => collapsed[dirPath] ?? !dirtyDirs.has(dirPath)
  const selectedEntry = selected ? files.find((f) => f.path === selected) : undefined

  const renderDir = (node: DirNode, depth: number): React.ReactNode => (
    <div key={node.path === '' ? '(root)' : node.path}>
      {node.path !== '' && (
        <button
          type="button"
          className="flex w-full items-center gap-1 rounded px-1.5 py-0.5 text-left text-faint hover:bg-accent/50"
          style={{ paddingLeft: `${depth * 12 + 6}px` }}
          onClick={() => setCollapsed((prev) => ({ ...prev, [node.path]: !isCollapsed(node.path) }))}
        >
          <span className="text-[10px]">{isCollapsed(node.path) ? '▸' : '▾'}</span>
          <span className="truncate">{node.name}</span>
        </button>
      )}
      {(node.path === '' || !isCollapsed(node.path)) && (
        <>
          {node.dirs.map((dir) => renderDir(dir, node.path === '' ? depth : depth + 1))}
          {node.files.map((entry) => {
            const badge = entry.status ? STATUS_BADGE[entry.status] : undefined
            const name = entry.path.split('/').at(-1) ?? entry.path
            return (
              <button
                key={entry.path}
                type="button"
                className={cn(
                  'flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left hover:bg-accent/50',
                  selected === entry.path && 'bg-accent text-accent-foreground',
                  entry.status === 'deleted' && 'line-through opacity-60'
                )}
                style={{ paddingLeft: `${(node.path === '' ? depth : depth + 1) * 12 + 18}px` }}
                onClick={() => {
                  setFollow(false) // from the moment they pick one themselves, the PERSON is steering — follow is turned back on explicitly
                  setSelected(entry.path)
                  setFile(undefined)
                  void openFile(entry.path, false)
                }}
              >
                <span className="min-w-0 flex-1 truncate">{name}</span>
                {badge && <span className={cn('font-mono text-[10px]', badge.className)}>{badge.letter}</span>}
              </button>
            )
          })}
        </>
      )}
    </div>
  )

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="text-[11.5px] text-faint">{t('label')}</span>
        {changedCount > 0 && (
          <span className="text-[11px] text-faint">{t('changed', { count: changedCount })}</span>
        )}
        <Button
          type="button"
          size="sm"
          variant={follow ? 'secondary' : 'ghost'}
          className="ml-auto"
          onClick={() => setFollow((prev) => !prev)}
        >
          {t('follow')}
        </Button>
      </div>
      <div className="flex h-[26rem] overflow-hidden rounded-lg border border-border">
        <div className="w-56 shrink-0 overflow-y-auto border-r border-border bg-card/50 py-1 text-[12px]">
          {renderDir(tree, 0)}
          {treeTruncated && <p className="px-2 py-1 text-[11px] text-faint">{t('treeTruncatedNote')}</p>}
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          {selected === undefined ? (
            <div className="flex flex-1 items-center justify-center p-4 text-[12px] text-neutral-500">
              {t('empty')}
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 border-b border-border px-2.5 py-1.5 text-[12px]">
                <span className="min-w-0 flex-1 truncate font-mono">{selected}</span>
                {file && file.found && file.diff !== '' && (
                  <div className="flex gap-1">
                    {(['file', 'diff'] as const).map((mode) => (
                      <Button
                        key={mode}
                        type="button"
                        size="sm"
                        variant={view === mode ? 'secondary' : 'ghost'}
                        onClick={() => setView(mode)}
                      >
                        {mode === 'file' ? t('tabFile') : t('tabDiff')}
                      </Button>
                    ))}
                  </div>
                )}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
                {file === undefined ? null : !file.found ? (
                  <p className="p-2 text-[12px] text-neutral-500">
                    {selectedEntry?.status === 'deleted' ? t('deletedNote') : t('missingNote')}
                  </p>
                ) : file.binary ? (
                  <p className="p-2 text-[12px] text-neutral-500">{t('binaryNote')}</p>
                ) : (
                  <div className="space-y-1.5">
                    {file.truncated && <p className="text-[11px] text-faint">{t('truncatedNote')}</p>}
                    <CodeEditor
                      value={view === 'diff' ? file.diff : file.content}
                      language={view === 'diff' ? 'diff' : languageFor(selected)}
                      minHeight="21rem"
                      maxHeight="21rem"
                      readOnly
                      aria-label={selected}
                    />
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
