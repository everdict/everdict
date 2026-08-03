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

// 본문에 실린 이미지를 제자리에서 크게 보는 뷰어. 이슈 화면의 스크린샷은 본문 열 폭(속성 열을 뺀 나머지)으로
// 줄어들어 들어오는데, 버그 리포트에 붙는 그림은 대개 "이 픽셀을 보라"는 그림이라 그 폭에서는 읽히지 않는다.
//
// 이미지마다 클라이언트 섬을 심지 않고 영역 하나가 위임(delegation)으로 받는 이유: 이 영역 안에는 서버가 그린
// 본문과 클라이언트가 그린 코멘트가 섞여 있고, 코멘트는 폴링으로 계속 다시 그려진다. 클릭 시점에 DOM 을 훑으면
// 그 순간 화면에 있는 이미지가 곧 좌우 이동의 목록이 되므로, 두 렌더 경로가 서로를 알 필요가 없다.
// 표식은 `Markdown` 이 이미지에 붙이는 `data-media-preview` 뿐이다.

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

// 링크로 감싼 이미지는 링크가 우선이다 — 배지(shields.io)나 "누르면 저쪽으로 가는 그림"이 대개 그 모양이라,
// 확대가 링크를 가로채면 갈 곳이 사라진다.
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
      {/* 위임 영역. 클릭은 이미지에서만 의미가 생기고, 나머지 클릭은 그대로 흘려보낸다. */}
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

  // 배율이 1 로 돌아오면 끌어 둔 위치도 같이 돌아온다 — 안 그러면 원본 크기인데 화면 밖에 가 있다.
  useEffect(() => {
    if (scale === MIN_SCALE) setPan({ x: 0, y: 0 })
  }, [scale])

  const reset = useCallback(() => {
    setScale(MIN_SCALE)
    setPan({ x: 0, y: 0 })
  }, [])

  // 사진을 넘기면 확대와 위치는 처음으로. 앞 사진에서 당겨 둔 배율이 다음 사진에 남으면 어디를 보고 있는지 알 수 없다.
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

  // 휠 확대는 리스너를 직접 단다 — React 의 onWheel 은 패시브라 preventDefault 가 먹지 않아 페이지가 같이 스크롤된다.
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

      {/* 가운데의 빈 자리를 누르면 닫힌다(Esc·닫기 버튼과 같은 일) — 사진 자체는 끌어서 움직이는 자리라 겹치면 안 된다. */}
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
