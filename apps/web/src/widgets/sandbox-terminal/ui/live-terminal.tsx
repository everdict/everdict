'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'

import { Input } from '@/shared/ui/input'

// Interactive sandbox terminal (observability ⑥) — a PERSISTENT shell over WebSocket: unlike the one-shot exec,
// cd / env / variables survive across commands. Line-oriented (type a command + Enter) so it needs no xterm; the
// shell has no TTY so we locally echo the command. Auth: POST for a short-lived ticket, then open the WS to the
// control plane directly (the ticket is the credential — a browser can't set a WS Authorization header).
export function LiveTerminal({ runId }: { runId: string }) {
  const t = useTranslations('liveTerminal')
  const [lines, setLines] = useState<string[]>([])
  const [command, setCommand] = useState('')
  const [state, setState] = useState<'connecting' | 'open' | 'closed'>('connecting')
  const wsRef = useRef<WebSocket | null>(null)
  const scroller = useRef<HTMLDivElement>(null)

  const append = (text: string) => {
    setLines((prev) => {
      const next = [...prev]
      // Merge continuation chunks into the last line unless they start a fresh newline block.
      next.push(text)
      return next.slice(-500)
    })
  }

  useEffect(() => {
    let ws: WebSocket | undefined
    let stopped = false
    ;(async () => {
      try {
        const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/terminal-ticket`, {
          method: 'POST',
        })
        if (!res.ok) {
          setState('closed')
          return
        }
        const { wsUrl, ticket } = (await res.json()) as { wsUrl: string; ticket: string }
        if (stopped) return
        ws = new WebSocket(`${wsUrl}?ticket=${encodeURIComponent(ticket)}`)
        wsRef.current = ws
        ws.addEventListener('open', () => setState('open'))
        ws.addEventListener('message', async (ev) => {
          const text = typeof ev.data === 'string' ? ev.data : await (ev.data as Blob).text()
          append(text)
        })
        ws.addEventListener('close', () => setState('closed'))
        ws.addEventListener('error', () => setState('closed'))
      } catch {
        setState('closed')
      }
    })()
    return () => {
      stopped = true
      ws?.close()
    }
  }, [runId])

  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight
  }, [lines])

  const send = (e: React.FormEvent) => {
    e.preventDefault()
    const cmd = command
    if (state !== 'open' || !wsRef.current) return
    append(`$ ${cmd}\n`) // local echo (the shell has no TTY)
    wsRef.current.send(`${cmd}\n`)
    setCommand('')
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span
          className={`inline-flex size-2 rounded-full ${
            state === 'open'
              ? 'bg-[var(--color-success)]'
              : state === 'connecting'
                ? 'bg-amber-400'
                : 'bg-muted-foreground'
          }`}
        />
        <span className="text-[11.5px] text-faint">{t(state)}</span>
      </div>
      <div
        ref={scroller}
        className="max-h-80 min-h-32 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-[#0b0b0c] p-3 font-mono text-[11.5px] leading-relaxed text-neutral-200"
      >
        {lines.length === 0 && <span className="text-neutral-500">{t('hint')}</span>}
        {lines.join('')}
      </div>
      <form onSubmit={send} className="flex items-center gap-2">
        <span className="select-none font-mono text-[13px] text-muted-foreground">$</span>
        <Input
          value={command}
          onChange={(ev) => setCommand(ev.target.value)}
          placeholder={t('placeholder')}
          disabled={state !== 'open'}
          className="font-mono text-[12px]"
          autoComplete="off"
          spellCheck={false}
        />
      </form>
    </div>
  )
}
