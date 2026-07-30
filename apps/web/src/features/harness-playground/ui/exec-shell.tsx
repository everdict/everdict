'use client'

import { useRef, useState } from 'react'
import { ChevronRight, TerminalSquare } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { cn } from '@/shared/lib/utils'
import { Input } from '@/shared/ui/input'

// A folded shell into the session's container — "what does it actually look like in there?" while a test case
// is being written. Not a PTY: each Enter POSTs one `sh -c` and appends the result to the scrollback (ls / cat /
// ps / env is the whole use case). A deliberate feature-local twin of widgets/sandbox-terminal rather than an
// import: FSD forbids features→widgets, and that widget is bound to a RUN's exec route, not a session's.

type Entry = { command: string; stdout: string; stderr: string; exitCode: number | null }

export function ExecShell({ sessionId }: { sessionId: string }) {
  const t = useTranslations('playground')
  const [open, setOpen] = useState(false)
  const [entries, setEntries] = useState<Entry[]>([])
  const [command, setCommand] = useState('')
  const [busy, setBusy] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)

  const run = async () => {
    const cmd = command.trim()
    if (cmd.length === 0 || busy) return
    setBusy(true)
    setCommand('')
    try {
      const res = await fetch(`/api/sandboxes/${encodeURIComponent(sessionId)}/exec`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: cmd }),
      })
      const body = (await res.json()) as {
        stdout?: string
        stderr?: string
        exitCode?: number
        message?: string
        error?: string
      }
      // A non-zero exit is a result the member wants to read; only a refused request becomes stderr text.
      setEntries((prev) => [
        ...prev,
        {
          command: cmd,
          stdout: body.stdout ?? '',
          stderr: res.ok ? (body.stderr ?? '') : (body.message ?? body.error ?? t('errorExec')),
          exitCode: typeof body.exitCode === 'number' ? body.exitCode : null,
        },
      ])
    } catch {
      setEntries((prev) => [
        ...prev,
        { command: cmd, stdout: '', stderr: t('errorExec'), exitCode: null },
      ])
    } finally {
      setBusy(false)
      requestAnimationFrame(() => {
        if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight
      })
    }
  }

  return (
    <div className="border-t border-border">
      <button
        type="button"
        onClick={() => setOpen((isOpen) => !isOpen)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-[11.5px] text-muted-foreground hover:text-foreground"
      >
        <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
        <TerminalSquare className="size-3.5" />
        {t('shellTitle')}
      </button>

      {open && (
        <div className="space-y-1.5 px-2 pb-2">
          <div
            ref={scroller}
            className="max-h-48 min-h-16 overflow-auto rounded-lg border border-border bg-[#0b0b0c] p-2.5 font-mono text-[11px] leading-relaxed"
          >
            {entries.length === 0 && <p className="text-neutral-500">{t('shellHint')}</p>}
            {entries.map((entry, index) => (
              <div key={index} className="mb-1.5">
                <div className="text-[var(--color-success)]">
                  <span className="select-none text-neutral-500">$ </span>
                  {entry.command}
                </div>
                {entry.stdout && (
                  <pre className="whitespace-pre-wrap text-neutral-200">{entry.stdout}</pre>
                )}
                {entry.stderr && (
                  <pre className="whitespace-pre-wrap text-red-400">{entry.stderr}</pre>
                )}
                {entry.exitCode !== null && entry.exitCode !== 0 && (
                  <div className="text-neutral-500">{t('shellExit', { code: entry.exitCode })}</div>
                )}
              </div>
            ))}
          </div>
          <Input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void run()
              }
            }}
            disabled={busy}
            placeholder={t('shellPlaceholder')}
            className="font-mono text-[11.5px]"
          />
        </div>
      )}
    </div>
  )
}
