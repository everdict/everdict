'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'

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

// 상태 배지 한 글자 — VS Code 관례(M/A/D)와 같은 색 문법.
const STATUS_BADGE: Record<FsStatus, { letter: string; className: string }> = {
  modified: { letter: 'M', className: 'text-amber-500' },
  added: { letter: 'A', className: 'text-emerald-500' },
  deleted: { letter: 'D', className: 'text-red-500' },
}

// 정렬된 평면 경로 목록 → 중첩 트리. 디렉터리 먼저, 그 다음 파일(각각 이름순) — 파일 탐색기의 표준 순서.
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

// 변경 파일을 품은 디렉터리 집합 — 사용자가 손대지 않은 디렉터리의 기본 펼침 상태를 결정한다
// (변경이 있는 가지는 자동으로 열리고, 사용자가 닫으면 그 선택이 이긴다).
function dirsWithChanges(entries: FsEntry[]): Set<string> {
  const dirty = new Set<string>()
  for (const entry of entries) {
    if (!entry.status) continue
    const segments = entry.path.split('/')
    for (let i = 1; i < segments.length; i += 1) dirty.add(segments.slice(0, i).join('/'))
  }
  return dirty
}

// 러닝 케이스 샌드박스의 라이브 리포 워크벤치 — 좌측 파일 탐색기(git 상태 배지) + 우측 읽기전용 에디터/diff.
// 트리를 4초마다 폴링하고, "따라가기"가 켜져 있으면 에이전트가 방금 바꾼 파일을 자동으로 연다. 리포가 없는
// 샌드박스(found=false)면 아무것도 렌더하지 않고, run 종료 후엔 마지막 상태를 그대로 둔다(exec 채널이 닫히므로).
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
  const followRef = useRef(follow)
  followRef.current = follow
  const selectedRef = useRef(selected)
  selectedRef.current = selected

  // 파일 1개 로드 — 폴링과 클릭이 경합하므로 시퀀스 번호로 낡은 응답을 버린다.
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
      // 따라가기로 열렸고 diff가 있으면 "무엇이 바뀌었나"를 먼저 보여준다; 직접 클릭은 파일 내용부터.
      setView(fromFollow && body.diff !== '' ? 'diff' : 'file')
    } catch {
      // transient — 다음 폴링이 다시 채운다
    }
  }

  useEffect(() => {
    if (initialStatus && TERMINAL.has(initialStatus)) return
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
            // 방금 상태가 바뀐 파일 → 따라가기 대상. 삭제는 열 것이 없으니 건너뛴다.
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
              // 열려 있는 파일이 아직 더럽혀지는 중이면 내용도 따라 새로고침한다.
              void openFile(current, false)
            }
          }
          if (body.status && TERMINAL.has(body.status)) return // run 종료 — 마지막 상태 유지
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
    // openFile은 ref 기반이라 안정적 — 폴링 루프는 runId 생명주기에만 묶는다.
  }, [runId, initialStatus])

  const tree = useMemo(() => (files ? buildTree(files) : undefined), [files])
  const dirtyDirs = useMemo(() => (files ? dirsWithChanges(files) : new Set<string>()), [files])
  const changedCount = useMemo(() => files?.filter((f) => f.status).length ?? 0, [files])

  // 리포가 한 번도 발견되지 않은 run(브라우저/OS 케이스 등) — 빈 박스 대신 통째로 숨긴다.
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
                  setFollow(false) // 직접 고른 순간부터는 사람이 조종한다 — 따라가기는 명시적으로 다시 켠다
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
