'use client'

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { ChevronLeft, ChevronRight, Download, Minus, Plus, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { createPortal } from 'react-dom'

import { fileNameForUrl } from '@/shared/lib/media'
import { cn } from '@/shared/lib/utils'

// The viewer that enlarges a body image in place. A screenshot on an issue screen arrives shrunk to the body column's width (what is left
// after the attribute column), and a picture attached to a bug report is usually a "look at THIS pixel" picture, unreadable at that width.
//
// Why one REGION receives it by delegation rather than planting a client island per image: this region mixes a body the server drew with
// comments the client drew, and the comments keep re-rendering from polling. Sweeping the DOM at CLICK time makes the images on screen at that
// moment the list for left/right navigation, so neither render path has to know about the other.
// The only marker is the `data-media-preview` that `Markdown` puts on an image.

interface Shot {
  src: string
  alt: string
}

const MIN_SCALE = 1
const MAX_SCALE = 8
const ZOOM_STEP = 1.35

function clampScale(value: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value))
}

// An image wrapped in a link belongs to the LINK — a badge (shields.io) or a "press the picture to go there" is usually that shape, and zoom
// hijacking the link removes the destination.
function previewable(node: Element | null): node is HTMLImageElement {
  return node instanceof HTMLImageElement && node.closest('a') === null
}

export function MediaLightbox({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [shots, setShots] = useState<Shot[]>([])
  const [at, setAt] = useState(0)

  function onClick(e: ReactMouseEvent<HTMLDivElement>) {
    const root = rootRef.current
    if (!root || !(e.target instanceof HTMLElement)) return
    const picked = e.target.closest('img[data-media-preview]')
    if (!previewable(picked)) return
    const all = Array.from(root.querySelectorAll('img[data-media-preview]')).filter(previewable)
    const index = all.indexOf(picked)
    if (index < 0) return
    e.preventDefault()
    setShots(all.map((img) => ({ src: img.currentSrc || img.src, alt: img.alt })))
    setAt(index)
  }

  return (
    <>
      {/* The delegation region. A click means something only on an image; every other click passes straight through. */}
      <div
        ref={rootRef}
        onClick={onClick}
        className={cn('[&_img[data-media-preview]]:cursor-zoom-in', className)}
      >
        {children}
      </div>
      {shots.length > 0 && (
        <LightboxOverlay shots={shots} at={at} onAt={setAt} onClose={() => setShots([])} />
      )}
    </>
  )
}

function LightboxOverlay({
  shots,
  at,
  onAt,
  onClose,
}: {
  shots: Shot[]
  at: number
  onAt: (index: number) => void
  onClose: () => void
}) {
  const t = useTranslations('mediaLightbox')
  const frameRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number } | undefined>(
    undefined
  )
  const [scale, setScale] = useState(MIN_SCALE)
  const [pan, setPan] = useState({ x: 0, y: 0 })

  const shot = shots[at]
  const first = at <= 0
  const last = at >= shots.length - 1

  const zoom = useCallback((factor: number) => {
    setScale((s) => clampScale(s * factor))
  }, [])

  // When the zoom returns to 1 the dragged position returns with it — otherwise it is at original size and off screen.
  useEffect(() => {
    if (scale === MIN_SCALE) setPan({ x: 0, y: 0 })
  }, [scale])

  const reset = useCallback(() => {
    setScale(MIN_SCALE)
    setPan({ x: 0, y: 0 })
  }, [])

  // Moving to the next picture resets zoom and position. A zoom pulled in on the previous picture, left on the next one, makes it impossible to tell what is being looked at.
  useEffect(() => {
    reset()
  }, [at, reset])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') return onClose()
      if (e.key === 'ArrowLeft' && at > 0) return onAt(at - 1)
      if (e.key === 'ArrowRight' && at < shots.length - 1) return onAt(at + 1)
      if (e.key === '+' || e.key === '=') return zoom(ZOOM_STEP)
      if (e.key === '-') return zoom(1 / ZOOM_STEP)
      if (e.key === '0') return reset()
    }
    document.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [at, shots.length, onAt, onClose, zoom, reset])

  // Wheel zoom attaches its listener directly — React's onWheel is passive, so preventDefault does not take and the page scrolls along with it.
  useEffect(() => {
    const el = frameRef.current
    if (!el) return
    function onWheel(e: WheelEvent) {
      e.preventDefault()
      zoom(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoom])

  if (shot === undefined || typeof document === 'undefined') return null

  function onPointerDown(e: ReactPointerEvent<HTMLImageElement>) {
    if (scale <= MIN_SCALE) return
    dragRef.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  function onPointerMove(e: ReactPointerEvent<HTMLImageElement>) {
    const from = dragRef.current
    if (from === undefined) return
    setPan({ x: from.panX + (e.clientX - from.x), y: from.panY + (e.clientY - from.y) })
  }
  function onPointerUp() {
    dragRef.current = undefined
  }

  const control =
    'inline-flex size-8 items-center justify-center rounded-md text-white/70 transition-colors hover:bg-white/12 hover:text-white disabled:pointer-events-none disabled:text-white/25'

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('title')}
      className="fixed inset-0 z-[120] flex flex-col bg-black/85 backdrop-blur-[2px] animate-in fade-in-0 duration-150"
    >
      <div className="flex shrink-0 items-center gap-1 px-3 py-2">
        {shots.length > 1 && (
          <span className="mr-1 font-mono text-[11.5px] tabular-nums text-white/60">
            {t('counter', { index: at + 1, total: shots.length })}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-white/60">{shot.alt}</span>
        <button
          type="button"
          onClick={() => zoom(1 / ZOOM_STEP)}
          aria-label={t('zoomOut')}
          className={control}
        >
          <Minus className="size-4" />
        </button>
        <button
          type="button"
          onClick={reset}
          aria-label={t('resetZoom')}
          className={cn(control, 'w-auto px-2 font-mono text-[11.5px] tabular-nums')}
        >
          {Math.round(scale * 100)}%
        </button>
        <button
          type="button"
          onClick={() => zoom(ZOOM_STEP)}
          aria-label={t('zoomIn')}
          className={control}
        >
          <Plus className="size-4" />
        </button>
        <a
          href={shot.src}
          download={fileNameForUrl(shot.src, t('downloadFallbackName'))}
          target="_blank"
          rel="noreferrer"
          aria-label={t('download')}
          className={control}
        >
          <Download className="size-4" />
        </a>
        <button type="button" onClick={onClose} aria-label={t('close')} className={control}>
          <X className="size-4" />
        </button>
      </div>

      {/* Pressing the empty space in the middle closes it (the same as Esc and the close button) — the picture itself is a place to DRAG, so they must not overlap. */}
      <div
        ref={frameRef}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose()
        }}
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden px-3 pb-3"
      >
        {shots.length > 1 && (
          <>
            <button
              type="button"
              onClick={() => onAt(at - 1)}
              disabled={first}
              aria-label={t('previous')}
              className={cn(control, 'absolute left-2 top-1/2 -translate-y-1/2 bg-black/40')}
            >
              <ChevronLeft className="size-5" />
            </button>
            <button
              type="button"
              onClick={() => onAt(at + 1)}
              disabled={last}
              aria-label={t('next')}
              className={cn(control, 'absolute right-2 top-1/2 -translate-y-1/2 bg-black/40')}
            >
              <ChevronRight className="size-5" />
            </button>
          </>
        )}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={shot.src}
          alt={shot.alt}
          draggable={false}
          onDoubleClick={() => (scale > MIN_SCALE ? reset() : zoom(ZOOM_STEP * ZOOM_STEP))}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})` }}
          className={cn(
            'max-h-full max-w-full select-none object-contain',
            scale > MIN_SCALE ? 'cursor-grab active:cursor-grabbing' : 'cursor-zoom-in'
          )}
        />
      </div>
    </div>,
    document.body
  )
}
