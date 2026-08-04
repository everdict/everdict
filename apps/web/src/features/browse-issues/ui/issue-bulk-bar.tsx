'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { createPortal } from 'react-dom'
import { CalendarClock, Loader2, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { moveIssuesToCycleAction } from '@/features/manage-issue'
import type { CycleState } from '@/entities/cycle'
import { cn } from '@/shared/lib/utils'
import { DropdownItem, DropdownMenu, DropdownSeparator } from '@/shared/ui/dropdown-menu'

import { useIssueSelection } from '../model/issue-selection'

export interface BulkCycleOption {
  id: string
  label: string
  state: CycleState
}

// 고른 이슈들에 한 번에 적용하는 액션 바 — 리니어의 동선이다. 상세 페이지의 사이클 피커는 한 건에 한 번이라
// 스무 건을 이번 주기로 끌어오려면 스무 페이지를 열어야 했다. 그게 사이클을 안 쓰게 만드는 지점이었다.
//
// <body> 로 포털한다(스코어카드 목록과 같은 이유): 페이지 전환 래퍼가 transform 을 애니메이션하고, transform
// 된 조상은 `fixed` 의 컨테이닝 블록이 되어 버려서 인라인으로 두면 바가 뷰포트가 아니라 긴 목록의 맨 아래에
// 붙는다. 위치는 이 목록의 콘텐츠 폭에 맞춰 잰다 — 인프라 패널이 열리면 화면 전체 기준의 가운데는 패널
// 아래로 미끄러진다.
export function IssueBulkBar({ cycles }: { cycles: BulkCycleOption[] }) {
  const t = useTranslations('issuesPage')
  const tracker = useTranslations('tracker')
  const router = useRouter()
  const selection = useIssueSelection()
  const [pending, startTransition] = useTransition()
  const anchorRef = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState<{ left: number; width: number } | null>(null)

  const count = selection?.selected.size ?? 0
  const active = count > 0

  useEffect(() => {
    const el = anchorRef.current
    if (!el || !active) return
    const measure = () => {
      const r = el.getBoundingClientRect()
      setBox({ left: r.left, width: r.width })
    }
    measure()
    const observed = el.closest('main') ?? el
    const ro = new ResizeObserver(measure)
    ro.observe(observed)
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [active])

  function move(cycleId: string | null): void {
    if (!selection) return
    const ids = [...selection.selected]
    startTransition(async () => {
      const r = await moveIssuesToCycleAction(ids, cycleId)
      // 부분 실패는 정상적인 결과다 — 옮겨진 것과 못 옮긴 것을 둘 다 말한다.
      if (r.failed > 0) toast.error(t('bulkCyclePartial', { moved: r.moved, failed: r.failed }))
      else toast.success(t('bulkCycleDone', { count: r.moved }))
      if (r.moved > 0) {
        selection.clear()
        router.refresh()
      }
    })
  }

  return (
    <div ref={anchorRef} aria-hidden className="pointer-events-none h-0" >
      {active &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="fixed bottom-6 z-30 flex justify-center px-4"
            style={box ? { left: box.left, width: box.width } : { left: 0, right: 0 }}
          >
            <div className="flex items-center gap-1 rounded-xl border border-border bg-card/95 px-2.5 py-2 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-card/80">
              <span className="px-1.5 text-[12.5px] font-[510] tabular-nums text-foreground">
                {t('bulkSelected', { count })}
              </span>
              <span className="mx-1 h-4 w-px bg-border" />
              <DropdownMenu
                align="start"
                side="top"
                contentClassName="w-56 p-1"
                trigger={({ toggle, open }) => (
                  <button
                    type="button"
                    onClick={toggle}
                    aria-expanded={open}
                    disabled={pending}
                    className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12.5px] text-foreground transition-colors hover:bg-accent disabled:opacity-50"
                  >
                    {pending ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <CalendarClock className="size-3.5 text-muted-foreground" />
                    )}
                    {t('bulkMoveToCycle')}
                  </button>
                )}
              >
                <div className="max-h-56 overflow-y-auto">
                  {cycles.map((cycle) => (
                    <DropdownItem
                      key={cycle.id}
                      icon={<CalendarClock className="size-3.5" />}
                      onSelect={() => move(cycle.id)}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate">{cycle.label}</span>
                        <span
                          className={cn(
                            'shrink-0 text-[11px]',
                            cycle.state === 'active' ? 'text-[var(--color-link)]' : 'text-faint'
                          )}
                        >
                          {tracker(`cycleState.${cycle.state}`)}
                        </span>
                      </span>
                    </DropdownItem>
                  ))}
                  {cycles.length === 0 && (
                    <p className="px-2 py-1.5 text-[12px] text-faint">{t('cycleNone')}</p>
                  )}
                </div>
                <DropdownSeparator />
                <DropdownItem icon={<X className="size-3.5" />} onSelect={() => move(null)}>
                  {t('cycleClear')}
                </DropdownItem>
              </DropdownMenu>
              <button
                type="button"
                onClick={() => selection?.clear()}
                className="rounded-md px-2 py-1 text-[12.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                {t('bulkClear')}
              </button>
            </div>
          </div>,
          document.body
        )}
    </div>
  )
}
