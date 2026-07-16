'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'

import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'

// The interactive browser canvas (browser-profiles S1) — the productized twin of scripts/live/interactive-browser.mjs
// `--serve`: a WebSocket (not SSE/POST) carries CDP screencast frames OUT (drawn to a <canvas>) and mouse/keyboard/
// navigate input IN. Auth: POST for a short-lived ticket, then open the WS to the control plane directly (a browser
// can't set a WS Authorization header — the ticket is the credential).
type ConnState = 'connecting' | 'live' | 'closed'

interface Frame {
  type: 'frame'
  data: string // base64 jpeg
  metadata: { deviceWidth: number; deviceHeight: number }
}

export function BrowserCanvas({ sessionId }: { sessionId: string }) {
  const t = useTranslations('interactiveBrowser')
  const [state, setState] = useState<ConnState>('connecting')
  const [url, setUrl] = useState('')
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const sizeRef = useRef({ w: 1280, h: 800 })

  const send = (msg: unknown) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  useEffect(() => {
    let ws: WebSocket | undefined
    let stopped = false
    ;(async () => {
      try {
        const res = await fetch(`/api/browser-sessions/${encodeURIComponent(sessionId)}/ticket`, {
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
        ws.addEventListener('open', () => setState('live'))
        ws.addEventListener('message', async (ev) => {
          const text = typeof ev.data === 'string' ? ev.data : await (ev.data as Blob).text()
          let msg: Frame | { type: 'error'; message: string }
          try {
            msg = JSON.parse(text)
          } catch {
            return
          }
          if (msg.type === 'error') {
            setState('closed')
            return
          }
          if (msg.type !== 'frame') return
          const canvas = canvasRef.current
          if (!canvas) return
          const ctx = canvas.getContext('2d')
          if (!ctx) return
          const img = new Image()
          img.onload = () => {
            sizeRef.current = { w: msg.metadata.deviceWidth, h: msg.metadata.deviceHeight }
            canvas.width = msg.metadata.deviceWidth
            canvas.height = msg.metadata.deviceHeight
            ctx.drawImage(img, 0, 0)
          }
          img.src = `data:image/jpeg;base64,${msg.data}`
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
  }, [sessionId])

  // Map a DOM pointer event to CDP viewport coordinates (canvas is scaled to fit via CSS).
  const toCdp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas) return { x: 0, y: 0 }
    const rect = canvas.getBoundingClientRect()
    const { w, h } = sizeRef.current
    return {
      x: ((e.clientX - rect.left) * w) / rect.width,
      y: ((e.clientY - rect.top) * h) / rect.height,
    }
  }

  const onKey = (e: React.KeyboardEvent<HTMLCanvasElement>) => {
    e.preventDefault()
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) send({ kind: 'key', type: 'char', text: e.key })
    else send({ kind: 'key', type: 'keyDown', key: e.key, code: e.code })
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span
          className={`inline-flex size-2 rounded-full ${
            state === 'live'
              ? 'bg-[var(--color-success)]'
              : state === 'connecting'
                ? 'bg-amber-400'
                : 'bg-muted-foreground'
          }`}
        />
        <span className="text-[11.5px] text-faint">{t(state)}</span>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (url.trim()) send({ kind: 'navigate', url: url.trim() })
        }}
        className="flex items-center gap-2"
      >
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={t('urlPlaceholder')}
          className="text-[12px]"
          autoComplete="off"
          spellCheck={false}
          disabled={state !== 'live'}
        />
        <Button type="submit" size="sm" variant="secondary" disabled={state !== 'live'}>
          {t('go')}
        </Button>
      </form>

      <div className="overflow-hidden rounded-lg border border-border bg-[#0b0b0c]">
        {state === 'closed' && (
          <div className="p-6 text-center text-[12px] text-neutral-500">{t('disconnected')}</div>
        )}
        <canvas
          ref={canvasRef}
          tabIndex={0}
          onMouseDown={(e) => {
            const p = toCdp(e)
            send({ kind: 'mouse', type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 })
            canvasRef.current?.focus()
          }}
          onMouseUp={(e) => {
            const p = toCdp(e)
            send({ kind: 'mouse', type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 })
          }}
          onMouseMove={(e) => {
            const p = toCdp(e)
            send({ kind: 'mouse', type: 'mouseMoved', x: p.x, y: p.y })
          }}
          onKeyDown={onKey}
          className={`block max-w-full outline-none ${state === 'closed' ? 'hidden' : ''}`}
        />
      </div>
      <p className="text-[11.5px] text-faint">{t('canvasHint')}</p>
    </div>
  )
}
