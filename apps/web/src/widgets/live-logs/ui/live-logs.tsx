'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'

import { cn } from '@/shared/lib/utils'

const TERMINAL = new Set(['succeeded', 'failed', 'superseded', 'cancelled'])
const POLL_MS = 3000
const STREAMS = ['stdout', 'stderr'] as const
type Stream = (typeof STREAMS)[number]

// Live progress tail of a RUNNING run's job (observability ②) — polls the BFF snapshot every 3s and appends
// only the new bytes (the log is append-only). Stops by itself once the run reaches a terminal status; the
// final text stays on screen so the last lines are readable next to the settled result.
// stdout|stderr toggle: many harnesses (e.g. browser-use) log progress to stderr while stdout carries only
// the final result block — without the toggle the live tail looks empty for exactly those harnesses.
export function LiveLogs({ runId, initialStatus }: { runId: string; initialStatus: string }) {
  const t = useTranslations('liveLogs')
  const [text, setText] = useState('')
  const [status, setStatus] = useState(initialStatus)
  const [found, setFound] = useState(false)
  const [stream, setStream] = useState<Stream>('stdout')
  const scroller = useRef<HTMLPreElement>(null)

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      try {
        const res = await fetch(
          `/api/runs/${encodeURIComponent(runId)}/logs${stream === 'stderr' ? '?stream=stderr' : ''}`
        )
        if (res.ok) {
          const body = (await res.json()) as { status: string; found: boolean; text: string }
          if (stopped) return
          setStatus(body.status)
          setFound(body.found)
          // Append-only: replace wholesale (the snapshot is the full current text) — cheaper than diff bookkeeping.
          setText(body.text)
          if (TERMINAL.has(body.status)) return // final snapshot rendered — stop polling
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
  }, [runId, stream])

  // Follow the tail while streaming (the reader can scroll up freely — only auto-stick when already at the bottom).
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    if (nearBottom) el.scrollTop = el.scrollHeight
  }, [text])

  const live = !TERMINAL.has(status)
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        {live && (
          <span className="relative flex size-2">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-[var(--color-success)] opacity-60" />
            <span className="relative inline-flex size-2 rounded-full bg-[var(--color-success)]" />
          </span>
        )}
        <span className="text-[11.5px] text-faint">{live ? t('streaming') : t('finished')}</span>
        <div className="ml-auto flex items-center gap-0.5 rounded-md border border-border p-0.5">
          {STREAMS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => {
                if (s === stream) return
                setStream(s)
                setText('')
                setFound(false)
              }}
              className={cn(
                'rounded px-1.5 py-0.5 font-mono text-[10.5px] transition-colors',
                s === stream
                  ? 'bg-muted text-foreground'
                  : 'text-faint hover:text-muted-foreground'
              )}
              title={t(s === 'stdout' ? 'stdoutHint' : 'stderrHint')}
            >
              {s}
            </button>
          ))}
        </div>
      </div>
      <pre
        ref={scroller}
        className="max-h-80 overflow-auto rounded-lg border border-border bg-muted/40 p-3 font-mono text-[11.5px] leading-relaxed text-muted-foreground"
      >
        {text || (found ? '' : t('waiting'))}
      </pre>
    </div>
  )
}
