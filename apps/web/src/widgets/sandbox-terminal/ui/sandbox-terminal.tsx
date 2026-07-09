'use client'

import { useRef, useState } from 'react'
import { useTranslations } from 'next-intl'

import { Input } from '@/shared/ui/input'

type Entry = {
  command: string
  stdout: string
  stderr: string
  exitCode: number | null
  found: boolean
}

// Sandbox web terminal (observability ④) — a one-shot command runner against the case's live container. Not a
// full PTY: each Enter POSTs `sh -c <command>` to the BFF and appends the result to the scrollback. Enough to
// inspect the sandbox mid-run (ls / cat / ps / env). Creator-or-admin is enforced by the control plane.
export function SandboxTerminal({ runId }: { runId: string }) {
  const t = useTranslations('sandboxTerminal')
  const [entries, setEntries] = useState<Entry[]>([])
  const [command, setCommand] = useState('')
  const [busy, setBusy] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const cmd = command.trim()
    if (!cmd || busy) return
    setBusy(true)
    setCommand('')
    try {
      const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/exec`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: cmd }),
      })
      const body = (await res.json()) as Omit<Entry, 'command'> & { error?: string }
      setEntries((prev) => [
        ...prev,
        {
          command: cmd,
          stdout: body.stdout ?? '',
          stderr: body.stderr ?? body.error ?? '',
          exitCode: body.exitCode ?? null,
          found: body.found ?? false,
        },
      ])
    } catch (err) {
      setEntries((prev) => [
        ...prev,
        { command: cmd, stdout: '', stderr: String(err), exitCode: null, found: false },
      ])
    } finally {
      setBusy(false)
      requestAnimationFrame(() => {
        if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight
      })
    }
  }

  return (
    <div className="space-y-2">
      <div
        ref={scroller}
        className="max-h-72 min-h-24 overflow-auto rounded-lg border border-border bg-[#0b0b0c] p-3 font-mono text-[11.5px] leading-relaxed"
      >
        {entries.length === 0 && <p className="text-neutral-500">{t('hint')}</p>}
        {entries.map((e, i) => (
          <div key={i} className="mb-2">
            <div className="text-[var(--color-success)]">
              <span className="select-none text-neutral-500">$ </span>
              {e.command}
            </div>
            {!e.found && <div className="text-amber-400">{t('noContainer')}</div>}
            {e.stdout && <pre className="whitespace-pre-wrap text-neutral-200">{e.stdout}</pre>}
            {e.stderr && <pre className="whitespace-pre-wrap text-red-400">{e.stderr}</pre>}
            {e.found && e.exitCode !== 0 && e.exitCode !== null && (
              <div className="text-neutral-500">{t('exit', { code: e.exitCode })}</div>
            )}
          </div>
        ))}
      </div>
      <form onSubmit={submit} className="flex items-center gap-2">
        <span className="select-none font-mono text-[13px] text-muted-foreground">$</span>
        <Input
          value={command}
          onChange={(ev) => setCommand(ev.target.value)}
          placeholder={t('placeholder')}
          disabled={busy}
          className="font-mono text-[12px]"
          autoComplete="off"
          spellCheck={false}
        />
      </form>
    </div>
  )
}
