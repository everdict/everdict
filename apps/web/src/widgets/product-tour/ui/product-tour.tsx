'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'

import { cn } from '@/shared/lib/utils'
import { START_TOUR_EVENT } from '@/shared/lib/tour'
import { buttonVariants } from '@/shared/ui/button'

// 신규 유저용 인터랙티브 온보딩 투어(코치마크) — 의존성 없이 직접 구현.
// 환영 카드 → 사이드바의 핵심 요소(data-tour 앵커)를 스포트라이트로 짚으며, 각 스텝은 본문 화면을 해당 섹션으로
// 이동시켜 "화면이 움직이며 짚어주는" 경험을 준다. 앵커는 모든 라우트에 존재하는 사이드바라서 소프트 내비게이션에도
// 안정적이다(ProductTour 는 AppShell 에 마운트되어 라우트 전환에도 상태 유지). 첫 데스크탑 방문에 자동 시작(localStorage),
// 이후 `everdict:start-tour` 이벤트로 재실행(가이드 페이지의 "둘러보기" 버튼).
const TOUR_VERSION = 'v1'
const DONE_KEY = `everdict:tour:done:${TOUR_VERSION}`

type Placement = 'right' | 'left' | 'bottom' | 'top'

interface TourStep {
  anchor: string // 화면 요소의 data-tour 값(사이드바 nav·검색·인프라 레일·알림·계정)
  titleKey: string
  bodyKey: string
  placement: Placement
  href?: string // 이 스텝에서 본문을 이동시킬 워크스페이스 상대 경로('' = 개요/워크스페이스 루트, undefined = 이동 없음)
}

// 모든 주요 화면을 사이드바 nav 순서대로 훑는다: 워크스페이스 → 검색 → 개요 → 하니스 → 데이터셋 → 스코어카드 →
// 평가자 → 스토어 → 뷰 → 가이드 → 알림 → 인프라(실행/예약/런타임/큐) → 계정. 각 nav 스텝은 본문을 해당 화면으로 이동.
const STEPS: TourStep[] = [
  { anchor: 'workspace-switcher', titleKey: 'workspace.title', bodyKey: 'workspace.body', placement: 'bottom' },
  { anchor: 'search', titleKey: 'search.title', bodyKey: 'search.body', placement: 'bottom' },
  { anchor: 'nav-overview', titleKey: 'overview.title', bodyKey: 'overview.body', placement: 'right', href: '' },
  { anchor: 'nav-harnesses', titleKey: 'harnesses.title', bodyKey: 'harnesses.body', placement: 'right', href: '/harnesses' },
  { anchor: 'nav-datasets', titleKey: 'datasets.title', bodyKey: 'datasets.body', placement: 'right', href: '/datasets' },
  { anchor: 'nav-scorecards', titleKey: 'scorecards.title', bodyKey: 'scorecards.body', placement: 'right', href: '/scorecards' },
  { anchor: 'nav-judges', titleKey: 'judges.title', bodyKey: 'judges.body', placement: 'right', href: '/judges' },
  { anchor: 'nav-store', titleKey: 'store.title', bodyKey: 'store.body', placement: 'right', href: '/store' },
  { anchor: 'nav-views', titleKey: 'views.title', bodyKey: 'views.body', placement: 'right', href: '/views' },
  { anchor: 'nav-guide', titleKey: 'guide.title', bodyKey: 'guide.body', placement: 'right', href: '/guide' },
  { anchor: 'notifications', titleKey: 'notifications.title', bodyKey: 'notifications.body', placement: 'bottom' },
  { anchor: 'infra-rail', titleKey: 'infra.title', bodyKey: 'infra.body', placement: 'left' },
  { anchor: 'user-menu', titleKey: 'account.title', bodyKey: 'account.body', placement: 'top' },
]

function isDesktop(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches
}

// 스포트라이트 — 하이라이트 영역(구멍) 둘레를 4개의 어두운 패널로 덮어 대상만 또렷하게 남긴다(구멍 영역은 클릭 통과).
function Spotlight({ rect }: { rect: DOMRect }) {
  const pad = 4
  const x = rect.left - pad
  const y = rect.top - pad
  const w = rect.width + pad * 2
  const h = rect.height + pad * 2
  const panel = 'absolute bg-black/55 backdrop-blur-[1px]'
  return (
    <>
      <div className={panel} style={{ top: 0, left: 0, right: 0, height: Math.max(0, y) }} />
      <div className={panel} style={{ top: y + h, left: 0, right: 0, bottom: 0 }} />
      <div className={panel} style={{ top: y, left: 0, width: Math.max(0, x), height: h }} />
      <div className={panel} style={{ top: y, left: x + w, right: 0, height: h }} />
    </>
  )
}

export function ProductTour({ workspace }: { workspace: string }) {
  const t = useTranslations('tour')
  const router = useRouter()
  const pathname = usePathname()
  const [running, setRunning] = useState(false)
  const [welcome, setWelcome] = useState(true)
  const [index, setIndex] = useState(0)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)

  const step = running && !welcome ? STEPS[index] : null

  // 첫 방문 자동 시작(데스크탑 한정 — 모바일은 사이드바가 드로어라 앵커가 숨겨짐).
  useEffect(() => {
    if (!isDesktop()) return
    let done = false
    try {
      done = localStorage.getItem(DONE_KEY) !== null
    } catch {
      done = true // 스토리지 접근 불가(프라이빗 모드 등)면 자동 시작하지 않는다.
    }
    if (done) return
    const id = window.setTimeout(() => {
      setWelcome(true)
      setIndex(0)
      setRunning(true)
    }, 700)
    return () => window.clearTimeout(id)
  }, [])

  // 재실행 이벤트(가이드 페이지 버튼 등). 투어 앵커는 데스크탑 사이드바라 모바일에선 조용히 무시한다.
  useEffect(() => {
    const start = () => {
      if (!isDesktop()) return
      setWelcome(true)
      setIndex(0)
      setRunning(true)
    }
    window.addEventListener(START_TOUR_EVENT, start)
    return () => window.removeEventListener(START_TOUR_EVENT, start)
  }, [])

  const finish = useCallback(() => {
    setRunning(false)
    setRect(null)
    setPos(null)
    try {
      localStorage.setItem(DONE_KEY, '1')
    } catch {
      // 스토리지 실패는 무시 — 세션 내에서 닫히기만 하면 된다.
    }
  }, [])

  // 스텝이 href 를 가지면 본문 화면을 이동(사이드바 앵커는 그대로라 스포트라이트는 안정적).
  // href === '' 는 개요(워크스페이스 루트)로 이동을 의미하므로 undefined 만 "이동 없음"으로 취급한다.
  useEffect(() => {
    if (step?.href === undefined) return
    const target = `/${workspace}${step.href}`
    if (pathname !== target) router.push(target)
  }, [step, workspace, pathname, router])

  // 대상 앵커 위치 측정(스텝 변경 + 스크롤/리사이즈). 라우트 이동 직후엔 레이아웃이 앉도록 약간 지연.
  useEffect(() => {
    if (!step) return
    let raf = 0
    const measure = () => {
      const el = document.querySelector<HTMLElement>(`[data-tour="${step.anchor}"]`)
      if (!el) {
        setRect(null) // 앵커를 못 찾으면 카드만 중앙에 띄운다(스텝이 사라지지 않도록).
        return
      }
      el.scrollIntoView({ block: 'nearest' })
      setRect(el.getBoundingClientRect())
    }
    const delay = step.href ? 240 : 60
    const timer = window.setTimeout(() => {
      raf = requestAnimationFrame(measure)
    }, delay)
    const onMove = () => {
      raf = requestAnimationFrame(measure)
    }
    window.addEventListener('resize', onMove)
    window.addEventListener('scroll', onMove, true)
    return () => {
      window.clearTimeout(timer)
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onMove)
      window.removeEventListener('scroll', onMove, true)
    }
  }, [step])

  // 카드 위치 — 대상 rect + 카드 실제 크기로 placement 계산 후 뷰포트 안으로 클램프.
  useLayoutEffect(() => {
    if (!rect || !cardRef.current || !step) return
    const card = cardRef.current.getBoundingClientRect()
    const gap = 12
    const vw = window.innerWidth
    const vh = window.innerHeight
    let top = rect.top
    let left = rect.left
    const midY = rect.top + rect.height / 2 - card.height / 2 // 좌/우 배치는 대상 세로 중앙에 정렬(가는 세로 레일에도 자연스럽게)
    if (step.placement === 'right') {
      left = rect.right + gap
      top = midY
    } else if (step.placement === 'left') {
      left = rect.left - card.width - gap
      top = midY
    } else if (step.placement === 'bottom') {
      top = rect.bottom + gap
      left = rect.left
    } else {
      top = rect.top - card.height - gap
      left = rect.left
    }
    left = Math.min(Math.max(8, left), vw - card.width - 8)
    top = Math.min(Math.max(8, top), vh - card.height - 8)
    setPos({ top, left })
  }, [rect, step])

  if (!running) return null

  // 환영 카드 — 중앙 모달. 시작/건너뛰기.
  if (welcome) {
    return (
      <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/55 backdrop-blur-[1px] p-4">
        <div
          role="dialog"
          aria-modal="true"
          className="w-full max-w-sm rounded-xl border border-border bg-popover p-6 text-popover-foreground shadow-pop"
        >
          <div className="text-2xl">👋</div>
          <h2 className="mt-2 text-[16px] font-[600] tracking-tight text-foreground">
            {t('welcome.title')}
          </h2>
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
            {t('welcome.body')}
          </p>
          <div className="mt-5 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={finish}
              className={buttonVariants({ size: 'sm', variant: 'ghost' })}
            >
              {t('skip')}
            </button>
            <button
              type="button"
              onClick={() => {
                setWelcome(false)
                setIndex(0)
              }}
              className={buttonVariants({ size: 'sm' })}
            >
              {t('start')}
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (!step) return null
  const total = STEPS.length
  const last = index === total - 1
  const cardStyle = pos
    ? { top: pos.top, left: pos.left }
    : rect
      ? { visibility: 'hidden' as const }
      : { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }

  return (
    <div className="fixed inset-0 z-[80]">
      {rect ? <Spotlight rect={rect} /> : <div className="absolute inset-0 bg-black/55 backdrop-blur-[1px]" />}
      {rect ? (
        <div
          className="pointer-events-none absolute rounded-md ring-2 ring-primary transition-all duration-200"
          style={{ top: rect.top - 4, left: rect.left - 4, width: rect.width + 8, height: rect.height + 8 }}
        />
      ) : null}
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        className="absolute w-[300px] rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-pop"
        style={cardStyle}
      >
        <div className="mb-1 text-[11px] font-[510] text-faint">
          {index + 1} / {total}
        </div>
        <h3 className="text-[13px] font-[560] text-foreground">{t(step.titleKey)}</h3>
        <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{t(step.bodyKey)}</p>
        <div className="mt-3.5 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={finish}
            className="text-[12px] text-muted-foreground transition-colors hover:text-foreground"
          >
            {t('skip')}
          </button>
          <div className="flex items-center gap-2">
            {index > 0 ? (
              <button
                type="button"
                onClick={() => setIndex((i) => i - 1)}
                className={buttonVariants({ size: 'xs', variant: 'secondary' })}
              >
                {t('back')}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => (last ? finish() : setIndex((i) => i + 1))}
              className={cn(buttonVariants({ size: 'xs' }))}
            >
              {last ? t('done') : t('next')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
