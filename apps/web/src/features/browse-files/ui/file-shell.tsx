'use client'

import { useRef, useState } from 'react'
import { useTranslations } from 'next-intl'

import type { FsEntryView } from '@/entities/workspace-file'
import { fmtBytes } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'

import {
  listFilesAction,
  makeDirectoryAction,
  moveEntryAction,
  readFileAction,
  removeEntryAction,
  writeFileAction,
} from '../api/browse-files'
import { baseNameOf, parentOf, resolveFsPath } from '../lib/fs-path'

// A bash-style shell over the workspace filesystem — the "feels like a real filesystem" surface. Commands map to
// the same server actions the tree uses; output is a raw monospace scrollback (terminal contract: command output
// stays untranslated, like the sandbox terminal). Write commands are gated client-side on canWrite for honest UX;
// the control plane enforces files:write regardless.
const HELP = [
  'help                     this help',
  'pwd                      print the current directory',
  'ls [path]                list a directory',
  'cd [path]                change directory',
  'cat <file>               print a text file',
  'tree [path]              recursive listing (depth 4)',
  'mkdir <path>             create a directory',
  'touch <file>             create an empty file',
  'echo <text…> >  <file>   write text to a file',
  'echo <text…> >> <file>   append text to a file',
  'cp <from> <to>           copy a file',
  'mv <from> <to>           move/rename (dir target: end with /)',
  'rm [-r] <path>           remove a file/dir (-r = recursive)',
  'clear                    clear the scrollback',
].join('\n')

const CAT_MAX_CHARS = 20_000

interface ShellLine {
  kind: 'cmd' | 'out' | 'err'
  text: string
}

function tokenize(line: string): string[] {
  const tokens: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m = re.exec(line)
  while (m !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3] ?? '')
    m = re.exec(line)
  }
  return tokens
}

function fmtEntryLine(e: FsEntryView): string {
  if (e.kind === 'dir') return `${e.name}/`
  return e.size !== undefined ? `${e.name}  (${fmtBytes(e.size)})` : e.name
}

export function FileShell({ canWrite, onMutated }: { canWrite: boolean; onMutated: () => void }) {
  const t = useTranslations('files')
  const [lines, setLines] = useState<ShellLine[]>([])
  const [input, setInput] = useState('')
  const [cwd, setCwd] = useState('')
  const [busy, setBusy] = useState(false)
  const [history, setHistory] = useState<string[]>([])
  const [historyIdx, setHistoryIdx] = useState(-1)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  function print(kind: ShellLine['kind'], text: string) {
    setLines((prev) => [...prev, { kind, text }])
    requestAnimationFrame(() =>
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
    )
  }

  async function listOrThrow(path: string): Promise<FsEntryView[]> {
    const res = await listFilesAction(path)
    if (!res.ok || !res.data) throw new Error(res.error ?? 'list failed')
    return res.data
  }

  async function assertDir(path: string): Promise<void> {
    if (path === '') return
    const siblings = await listOrThrow(parentOf(path))
    const hit = siblings.find((e) => e.name === baseNameOf(path))
    if (!hit) throw new Error(`no such directory: /${path}`)
    if (hit.kind !== 'dir') throw new Error(`not a directory: /${path}`)
  }

  async function tree(
    path: string,
    depth: number,
    prefix: string,
    budget: { left: number }
  ): Promise<string[]> {
    if (depth === 0 || budget.left <= 0) return []
    const entries = await listOrThrow(path)
    const out: string[] = []
    for (let i = 0; i < entries.length; i++) {
      if (budget.left-- <= 0) {
        out.push(`${prefix}…`)
        break
      }
      const e = entries[i]
      if (!e) continue
      const last = i === entries.length - 1
      out.push(`${prefix}${last ? '└── ' : '├── '}${fmtEntryLine(e)}`)
      if (e.kind === 'dir') {
        out.push(...(await tree(e.path, depth - 1, `${prefix}${last ? '    ' : '│   '}`, budget)))
      }
    }
    return out
  }

  function requireWrite() {
    if (!canWrite) throw new Error('permission denied: the member role (files:write) is required')
  }

  async function execute(line: string): Promise<void> {
    const tokens = tokenize(line)
    const cmd = tokens[0]
    if (!cmd) return
    const arg = (i: number) => tokens[i]

    switch (cmd) {
      case 'help':
        print('out', HELP)
        return
      case 'clear':
        setLines([])
        return
      case 'pwd':
        print('out', `/${cwd}`)
        return
      case 'ls': {
        const target = arg(1) !== undefined ? resolveFsPath(cwd, arg(1) ?? '') : cwd
        const entries = await listOrThrow(target)
        print('out', entries.length === 0 ? '(empty)' : entries.map(fmtEntryLine).join('\n'))
        return
      }
      case 'cd': {
        const target = arg(1) !== undefined ? resolveFsPath(cwd, arg(1) ?? '') : ''
        await assertDir(target)
        setCwd(target)
        return
      }
      case 'cat': {
        const file = arg(1)
        if (file === undefined) throw new Error('usage: cat <file>')
        const res = await readFileAction(resolveFsPath(cwd, file))
        if (!res.ok || !res.data) throw new Error(res.error ?? 'read failed')
        if (res.data.encoding === 'base64') {
          print('out', `(binary file, ${fmtBytes(res.data.entry.size ?? 0)})`)
        } else {
          const text = res.data.content
          print(
            'out',
            text.length > CAT_MAX_CHARS ? `${text.slice(0, CAT_MAX_CHARS)}\n… (truncated)` : text
          )
        }
        return
      }
      case 'tree': {
        const target = arg(1) !== undefined ? resolveFsPath(cwd, arg(1) ?? '') : cwd
        const out = await tree(target, 4, '', { left: 200 })
        print('out', out.length === 0 ? '(empty)' : [`/${target}`, ...out].join('\n'))
        return
      }
      case 'mkdir': {
        requireWrite()
        const dir = arg(1)
        if (dir === undefined) throw new Error('usage: mkdir <path>')
        const res = await makeDirectoryAction(resolveFsPath(cwd, dir))
        if (!res.ok) throw new Error(res.error ?? 'mkdir failed')
        onMutated()
        return
      }
      case 'touch': {
        requireWrite()
        const file = arg(1)
        if (file === undefined) throw new Error('usage: touch <file>')
        const path = resolveFsPath(cwd, file)
        const existing = await readFileAction(path)
        if (existing.ok) return // touch on an existing file is a no-op here (no mtime bump)
        // baseRevision 0 closes the gap between that check and this write: if someone (or an agent) created the
        // file in between, touch is refused rather than blanking what they just wrote.
        const res = await writeFileAction({ path, content: '', baseRevision: 0 })
        if (!res.ok) throw new Error(res.error ?? 'touch failed')
        onMutated()
        return
      }
      case 'echo': {
        const redirectAt = tokens.findIndex((tok) => tok === '>' || tok === '>>')
        if (redirectAt === -1) {
          print('out', tokens.slice(1).join(' '))
          return
        }
        requireWrite()
        const file = tokens[redirectAt + 1]
        if (file === undefined) throw new Error('usage: echo <text> > <file>')
        const path = resolveFsPath(cwd, file)
        let content = tokens.slice(1, redirectAt).join(' ')
        if (tokens[redirectAt] === '>>') {
          const existing = await readFileAction(path)
          if (existing.ok && existing.data && existing.data.encoding === 'utf8') {
            content = `${existing.data.content}${content}`
          }
        }
        const res = await writeFileAction({ path, content: `${content}\n` })
        if (!res.ok) throw new Error(res.error ?? 'write failed')
        onMutated()
        return
      }
      case 'cp': {
        requireWrite()
        const from = arg(1)
        const to = arg(2)
        if (from === undefined || to === undefined) throw new Error('usage: cp <from> <to>')
        const src = resolveFsPath(cwd, from)
        let dst = resolveFsPath(cwd, to)
        if (to.endsWith('/')) dst = dst === '' ? baseNameOf(src) : `${dst}/${baseNameOf(src)}`
        const res = await readFileAction(src)
        if (!res.ok || !res.data) throw new Error(res.error ?? 'read failed')
        const write = await writeFileAction({
          path: dst,
          content: res.data.content,
          encoding: res.data.encoding,
          ...(res.data.entry.contentType !== undefined
            ? { contentType: res.data.entry.contentType }
            : {}),
        })
        if (!write.ok) throw new Error(write.error ?? 'write failed')
        onMutated()
        return
      }
      case 'mv': {
        requireWrite()
        const from = arg(1)
        const to = arg(2)
        if (from === undefined || to === undefined) throw new Error('usage: mv <from> <to>')
        const src = resolveFsPath(cwd, from)
        let dst = resolveFsPath(cwd, to)
        if (to.endsWith('/')) dst = dst === '' ? baseNameOf(src) : `${dst}/${baseNameOf(src)}`
        const res = await moveEntryAction(src, dst)
        if (!res.ok) throw new Error(res.error ?? 'move failed')
        onMutated()
        return
      }
      case 'rm': {
        requireWrite()
        const recursive = tokens.includes('-r') || tokens.includes('-rf')
        const target = tokens.slice(1).find((tok) => !tok.startsWith('-'))
        if (target === undefined) throw new Error('usage: rm [-r] <path>')
        const res = await removeEntryAction(resolveFsPath(cwd, target), recursive)
        if (!res.ok) throw new Error(res.error ?? 'remove failed')
        onMutated()
        return
      }
      default:
        throw new Error(`command not found: ${cmd} (try help)`)
    }
  }

  async function submit() {
    const line = input.trim()
    if (line === '' || busy) return
    setInput('')
    setHistory((prev) => [...prev, line])
    setHistoryIdx(-1)
    print('cmd', `/${cwd} $ ${line}`)
    setBusy(true)
    try {
      await execute(line)
    } catch (e) {
      print('err', e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      void submit()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (history.length === 0) return
      const next = historyIdx === -1 ? history.length - 1 : Math.max(0, historyIdx - 1)
      setHistoryIdx(next)
      setInput(history[next] ?? '')
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (historyIdx === -1) return
      const next = historyIdx + 1
      if (next >= history.length) {
        setHistoryIdx(-1)
        setInput('')
      } else {
        setHistoryIdx(next)
        setInput(history[next] ?? '')
      }
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-3.5 py-2">
        <span className="text-[13px] font-[510] text-foreground">{t('shellTitle')}</span>
        <span className="hidden text-[11.5px] text-muted-foreground sm:block">
          {t('shellHint')}
        </span>
      </div>
      {/* click-to-focus on the terminal body mirrors real terminals */}
      <div
        ref={scrollRef}
        className="h-56 cursor-text overflow-y-auto px-3.5 py-2 font-mono text-[12px] leading-relaxed"
        onClick={() => inputRef.current?.focus()}
      >
        {lines.map((line, i) => (
          <pre
            // append-only scrollback — the index is a stable key here
            key={`${i}-${line.kind}`}
            className={cn(
              'whitespace-pre-wrap break-all',
              line.kind === 'cmd' && 'text-foreground',
              line.kind === 'out' && 'text-muted-foreground',
              line.kind === 'err' && 'text-destructive'
            )}
          >
            {line.text}
          </pre>
        ))}
        <div className="flex items-center gap-1.5">
          <span className="shrink-0 font-mono text-[12px] text-primary">/{cwd} $</span>
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={busy}
            spellCheck={false}
            autoComplete="off"
            aria-label={t('shellTitle')}
            className="w-full bg-transparent font-mono text-[12px] text-foreground outline-none placeholder:text-muted-foreground/60"
            placeholder={busy ? '…' : ''}
          />
        </div>
      </div>
    </div>
  )
}
