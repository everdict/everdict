'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'

import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'

// The interactive browser canvas (browser-profiles S1) — the productized twin of scripts/live/interactive-browser.mjs
// `--serve`: a WebSocket (not SSE/POST) carries CDP screencast frames OUT (drawn to a <canvas>) and mouse/keyboard/
// navigate input IN. Auth: POST for a short-lived ticket, then open the WS to the control plane directly (a browser
// can't set a WS Authorization header — the ticket is the credential).
//
// Input model:
// - The remote viewport FOLLOWS the canvas: a ResizeObserver sends `resize` (debounced) so frames are 1:1 with the
//   on-screen size — no scaling blur, correct hit-testing.
// - Wheel events forward as CDP mouseWheel (native listener — React's onWheel is passive, preventDefault would warn).
// - Keyboard goes through a hidden textarea (the IME proxy): ASCII keys forward per keystroke, while composed input
//   (Korean/Japanese/…) commits as ONE `insertText` on compositionend — per-key char events cannot express Hangul.
type ConnState = 'connecting' | 'live' | 'closed'

interface Frame {
  type: 'frame'
  data: string // base64 jpeg
  metadata: { deviceWidth: number; deviceHeight: number }
}

// CDP Input.dispatchKeyEvent needs Windows virtual key codes for control keys to actually act (Enter submits,
// Backspace deletes, arrows move) — key/code strings alone are ignored by many handlers.
const VIRTUAL_KEYS: Record<string, number> = {
  Enter: 13,
  Backspace: 8,
  Tab: 9,
  Escape: 27,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
  Home: 36,
  End: 35,
  PageUp: 33,
  PageDown: 34,
}

// Viewport bounds mirror the server-side resize validation (browser-session-ws).
const VIEWPORT = { minW: 320, maxW: 2560, minH: 240, maxH: 1600, aspect: 5 / 8 }

// DOM MouseEvent.button index → CDP button name.
const MOUSE_BUTTONS = ['left', 'middle', 'right'] as const

// CDP modifiers bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8 — without it every shortcut/shift-selection is dead remotely.
const modifiersOf = (e: {
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}): number => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0)

// Windows virtual key code — alphanumerics derive from the uppercase code point, control keys from the map.
const vkOf = (key: string): number | undefined => {
  if (key.length === 1) {
    const cp = key.toUpperCase().codePointAt(0) ?? 0
    return (cp >= 48 && cp <= 57) || (cp >= 65 && cp <= 90) ? cp : undefined
  }
  return VIRTUAL_KEYS[key]
}

export function BrowserCanvas({ sessionId }: { sessionId: string }) {
  const t = useTranslations('interactiveBrowser')
  const [state, setState] = useState<ConnState>('connecting')
  const [url, setUrl] = useState('')
  const [keyboardOn, setKeyboardOn] = useState(false)
  const [viewport, setViewport] = useState<{ w: number; h: number } | null>(null)
  const shellRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const keyboardRef = useRef<HTMLTextAreaElement>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const sizeRef = useRef({ w: 1280, h: 800 })
  const lastSentViewportRef = useRef<{ w: number; h: number } | null>(null)
  // The initial resize must go out right after the WS opens — keep the measurer reachable from the open handler.
  const measureRef = useRef<() => void>(() => {})
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null)
  const pendingFrameRef = useRef<Frame | null>(null)
  const decodingRef = useRef(false)
  const moveRef = useRef<{ x: number; y: number; buttons: number; modifiers: number } | null>(null)
  const moveScheduledRef = useRef(false)

  const send = (msg: unknown) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  // Latest-wins frame pipeline: one decode in flight, newest frame replaces any waiting one. createImageBitmap
  // decodes off the main thread and, unlike per-frame data-URL <img>s, cannot complete out of order (a stale frame
  // finishing late used to overwrite a newer one). The canvas is only re-sized on an actual dimension change —
  // assigning canvas.width every frame force-clears it and was costing a full re-raster per frame.
  const drawPending = async () => {
    if (decodingRef.current) return
    decodingRef.current = true
    try {
      for (;;) {
        const frame = pendingFrameRef.current
        pendingFrameRef.current = null
        if (!frame) break
        const canvas = canvasRef.current
        if (!canvas) break
        const bytes = Uint8Array.from(atob(frame.data), (c) => c.charCodeAt(0))
        const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }))
        sizeRef.current = { w: frame.metadata.deviceWidth, h: frame.metadata.deviceHeight }
        if (canvas.width !== bitmap.width) canvas.width = bitmap.width
        if (canvas.height !== bitmap.height) canvas.height = bitmap.height
        // desynchronized: let the canvas present without vsync-locking the compositor (lower perceived latency).
        const ctx =
          ctxRef.current ??
          canvas.getContext('2d', { desynchronized: true }) ??
          canvas.getContext('2d')
        ctxRef.current = ctx
        ctx?.drawImage(bitmap, 0, 0)
        bitmap.close()
      }
    } catch {
      // a frame failed to decode — the next one repaints
    } finally {
      decodingRef.current = false
    }
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
        ws.addEventListener('open', () => {
          setState('live')
          measureRef.current() // fit the remote viewport to the canvas before the first real frame
        })
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
          pendingFrameRef.current = msg
          void drawPending()
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

  // Remote viewport follows the canvas size (debounced) — frames stay 1:1 with the on-screen pixels.
  useEffect(() => {
    const el = shellRef.current
    if (!el) return
    const measure = () => {
      const width = Math.round(el.clientWidth)
      if (width < 50) return // hidden / not laid out yet
      const w = Math.min(VIEWPORT.maxW, Math.max(VIEWPORT.minW, width))
      const h = Math.min(VIEWPORT.maxH, Math.max(VIEWPORT.minH, Math.round(w * VIEWPORT.aspect)))
      const last = lastSentViewportRef.current
      if (last && Math.abs(last.w - w) < 8 && last.h === h) return // ignore sub-pixel churn
      lastSentViewportRef.current = { w, h }
      setViewport({ w, h })
      send({ kind: 'resize', width: w, height: h })
    }
    measureRef.current = measure
    let timer: ReturnType<typeof setTimeout> | undefined
    const observer = new ResizeObserver(() => {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(measure, 250)
    })
    observer.observe(el)
    return () => {
      if (timer !== undefined) clearTimeout(timer)
      observer.disconnect()
    }
  }, [])

  // Wheel → CDP mouseWheel. A native non-passive listener: React's delegated onWheel is passive, so
  // preventDefault (needed to keep the page itself from scrolling) is impossible there.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = canvas.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return
      const { w, h } = sizeRef.current
      const lineScale = e.deltaMode === 1 ? 16 : 1 // Firefox reports lines, CDP wants pixels
      send({
        kind: 'mouse',
        type: 'mouseWheel',
        x: ((e.clientX - rect.left) * w) / rect.width,
        y: ((e.clientY - rect.top) * h) / rect.height,
        button: 'none',
        deltaX: e.deltaX * lineScale,
        deltaY: e.deltaY * lineScale,
        modifiers: modifiersOf(e),
      })
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [])

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

  // Keyboard proxy (hidden textarea). Every key forwards as a real keyDown/keyUp pair — a printable keyDown carries
  // `text` so the remote gets the full keydown/keypress/input sequence (the Puppeteer model; the old char-only path
  // skipped keydown and broke key-gated site handlers). IME composition mirrors live and commits on compositionend.
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.key === 'Process') return // IME is composing locally
    // Cmd/Ctrl+V stays local: the paste event forwards the LOCAL clipboard as insertText — forwarding the chord
    // would ALSO paste the remote browser's (stale) clipboard on top of it.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') return
    e.preventDefault()
    const virtualKey = vkOf(e.key)
    const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey
    send({
      kind: 'key',
      type: 'keyDown',
      key: e.key,
      code: e.code,
      modifiers: modifiersOf(e),
      ...(virtualKey !== undefined ? { windowsVirtualKeyCode: virtualKey } : {}),
      ...(printable ? { text: e.key } : {}),
      ...(e.key === 'Enter' ? { text: '\r' } : {}), // Enter needs text to fire input events remotely
    })
  }
  const onKeyUp = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.key === 'Process') return
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') return
    e.preventDefault()
    const virtualKey = vkOf(e.key)
    send({
      kind: 'key',
      type: 'keyUp',
      key: e.key,
      code: e.code,
      modifiers: modifiersOf(e),
      ...(virtualKey !== undefined ? { windowsVirtualKeyCode: virtualKey } : {}),
    })
  }
  // Mirror the in-progress composition remotely (Input.imeSetComposition) — the user watches Hangul form live in
  // the remote field instead of typing into a void until commit.
  const onCompositionUpdate = (e: React.CompositionEvent<HTMLTextAreaElement>) =>
    send({ kind: 'compose', text: e.data ?? '' })
  const onCompositionEnd = (e: React.CompositionEvent<HTMLTextAreaElement>) => {
    if (e.data) send({ kind: 'insertText', text: e.data }) // committing replaces the mirrored composition
    e.currentTarget.value = '' // the proxy never accumulates text
  }
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    e.preventDefault()
    const text = e.clipboardData.getData('text')
    if (text) send({ kind: 'insertText', text })
  }

  const navigate = () => {
    const trimmed = url.trim()
    if (!trimmed) return
    // Bare domains are the common case — default the scheme instead of failing silently.
    const target = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
    send({ kind: 'navigate', url: target })
    keyboardRef.current?.focus({ preventScroll: true })
  }

  return (
    <div className="space-y-2">
      <div
        className={cn(
          'overflow-hidden rounded-lg border bg-[#0b0b0c] transition-[border-color,box-shadow]',
          keyboardOn ? 'border-primary/50 ring-1 ring-primary/30' : 'border-border'
        )}
      >
        {/* Browser-chrome toolbar — status dot · address bar · viewport chip. */}
        <div className="flex items-center gap-2 border-b border-border/60 bg-card px-2.5 py-1.5">
          <span
            className={`inline-flex size-2 shrink-0 rounded-full ${
              state === 'live'
                ? 'bg-[var(--color-success)]'
                : state === 'connecting'
                  ? 'bg-amber-400'
                  : 'bg-muted-foreground'
            }`}
            title={t(state)}
          />
          <form
            onSubmit={(e) => {
              e.preventDefault()
              navigate()
            }}
            className="flex min-w-0 flex-1 items-center gap-1.5"
          >
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={t('urlPlaceholder')}
              className="h-7 border-transparent bg-background/70 text-[12px] focus-visible:border-border"
              autoComplete="off"
              spellCheck={false}
              disabled={state !== 'live'}
            />
            <Button
              type="submit"
              size="sm"
              variant="secondary"
              className="h-7"
              disabled={state !== 'live'}
            >
              {t('go')}
            </Button>
          </form>
          {viewport && (
            <span className="hidden shrink-0 font-mono text-[10.5px] text-faint sm:inline">
              {viewport.w}×{viewport.h}
            </span>
          )}
        </div>

        {state === 'closed' ? (
          <div className="p-6 text-center text-[12px] text-neutral-500">{t('disconnected')}</div>
        ) : (
          <div ref={shellRef} className="relative">
            <canvas
              ref={canvasRef}
              onMouseDown={(e) => {
                const p = toCdp(e)
                send({
                  kind: 'mouse',
                  type: 'mousePressed',
                  x: p.x,
                  y: p.y,
                  button: MOUSE_BUTTONS[e.button] ?? 'left', // right-click reaches the remote page too
                  buttons: e.buttons,
                  clickCount: e.detail || 1, // double-click selects remotely too
                  modifiers: modifiersOf(e),
                })
                keyboardRef.current?.focus({ preventScroll: true })
              }}
              onMouseUp={(e) => {
                const p = toCdp(e)
                send({
                  kind: 'mouse',
                  type: 'mouseReleased',
                  x: p.x,
                  y: p.y,
                  button: MOUSE_BUTTONS[e.button] ?? 'left',
                  buttons: e.buttons,
                  clickCount: e.detail || 1,
                  modifiers: modifiersOf(e),
                })
              }}
              onMouseMove={(e) => {
                // Coalesce to one move per animation frame — an unthrottled stream floods the relay and starves
                // clicks/keys behind hundreds of queued moves. `buttons` rides along so drags select/slide remotely.
                const p = toCdp(e)
                moveRef.current = {
                  x: p.x,
                  y: p.y,
                  buttons: e.buttons,
                  modifiers: modifiersOf(e),
                }
                if (moveScheduledRef.current) return
                moveScheduledRef.current = true
                requestAnimationFrame(() => {
                  moveScheduledRef.current = false
                  const m = moveRef.current
                  if (m) send({ kind: 'mouse', type: 'mouseMoved', ...m })
                })
              }}
              onContextMenu={(e) => e.preventDefault()} // no local menu over the remote screen
              className="block w-full cursor-default select-none outline-none"
            />
            {/* Hidden IME proxy — receives all keystrokes; Hangul/kana compose here and commit as insertText. */}
            <textarea
              ref={keyboardRef}
              tabIndex={-1}
              aria-hidden
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              onKeyDown={onKeyDown}
              onKeyUp={onKeyUp}
              onCompositionUpdate={onCompositionUpdate}
              onCompositionEnd={onCompositionEnd}
              onPaste={onPaste}
              onFocus={() => setKeyboardOn(true)}
              onBlur={() => setKeyboardOn(false)}
              className="absolute bottom-0 left-0 size-px resize-none opacity-0"
            />
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11.5px] text-faint">
          {t('canvasHint')} {t('imeHint')}
        </p>
        <span
          className={cn(
            'shrink-0 text-[11px]',
            keyboardOn ? 'text-[var(--color-success)]' : 'text-faint'
          )}
        >
          {keyboardOn ? t('keyboardAttached') : state === 'live' ? t('keyboardDetached') : ''}
        </span>
      </div>
    </div>
  )
}
