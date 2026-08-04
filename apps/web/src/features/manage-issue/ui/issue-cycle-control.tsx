'use client'

import { useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { CalendarClock, Check, ChevronDown, Loader2, Plus, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { type CycleState } from '@/entities/cycle'
import { cn } from '@/shared/lib/utils'
import { DropdownItem, DropdownMenu, DropdownSeparator } from '@/shared/ui/dropdown-menu'

import { updateIssueAction } from '../api/issues'

export interface IssueCycleOption {
  id: string
  label: string
  // 지금 돌고 있는 것인지, 다음인지. 「이번 주기에 넣기」와 「다음으로 미루기」는 다른 결정이라 목록이 그 둘을
  // 구분해서 보여 준다.
  state: CycleState
  href: string
}

// 이슈가 들어간 이터레이션 — 상태·우선순위·팀·프로젝트와 같은 자리(속성 열)에서 바로 넣고 뺀다. 예전에는
// 붙어 있을 때만 링크 한 줄로 보였고 넣는 길이 화면 어디에도 없었다: 사이클을 만들 수는 있는데 이슈를 넣을 수는
// 없는 상태였다.
//
// 목록은 열려 있는 사이클만이다(닫힌 이터레이션은 계획이 아니라 기록이다). 이미 붙어 있는 사이클은 링크로
// 남고, 바꾸는 것은 그 옆의 작은 트리거가 맡는다 — 읽는 자리와 바꾸는 자리를 겹치지 않게.
export function IssueCycleControl({
  id,
  cycle,
  cycles,
  canWrite,
}: {
  id: string
  cycle: IssueCycleOption | undefined
  // 이 이슈의 팀이 가진 열린 사이클들(화면이 팀으로 좁혀 온다). 이슈는 자기 팀의 사이클에만 들어가고 그건
  // 제어 평면이 강제하므로, 여기 있는 것은 전부 실제로 고를 수 있는 것들이다.
  cycles: IssueCycleOption[]
  canWrite: boolean
}) {
  const t = useTranslations('issuesPage')
  const tracker = useTranslations('tracker')
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  // `null` 은 비운다 — 사이클에서 뺀다는 뜻이고, `undefined`(손대지 않음)와 절대 섞이면 안 된다.
  // 낙관적으로 그리지 않는다: 실패하면 서버가 이유를 말하고, 화면은 새로고침으로 진실을 다시 받는다.
  function assign(cycleId: string | null): void {
    if (cycleId === (cycle?.id ?? null)) return
    startTransition(async () => {
      const r = await updateIssueAction(id, { cycleId })
      if (!r.ok) {
        toast.error(r.error ?? t('cycleError'))
        return
      }
      router.refresh()
    })
  }

  const chip = cycle ? (
    <Link
      href={cycle.href}
      className="inline-flex min-w-0 items-center gap-1.5 transition-colors hover:text-foreground"
    >
      <CalendarClock className="size-3.5 shrink-0 text-faint" />
      <span className="truncate">{cycle.label}</span>
    </Link>
  ) : null

  if (!canWrite) return chip

  return (
    <div className="flex min-w-0 items-center gap-1">
      {chip}
      <DropdownMenu
        align="end"
        contentClassName="w-56 p-1"
        trigger={({ toggle, open }) => (
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            aria-label={t('cycleControlLabel')}
            disabled={pending}
            className={cn(
              'shrink-0 transition-colors disabled:opacity-50',
              cycle
                ? 'inline-flex size-5 items-center justify-center rounded text-faint hover:bg-accent hover:text-foreground'
                : // 아직 어느 주기에도 없는 이슈에서는 이 버튼이 유일한 안내다 — 그때만 글자를 단다.
                  'inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5 text-[11.5px] text-muted-foreground hover:border-border-strong hover:bg-accent hover:text-foreground'
            )}
          >
            {pending ? (
              <Loader2 className="size-3 animate-spin" />
            ) : cycle ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <>
                <Plus className="size-3" />
                <span>{t('cycleAdd')}</span>
              </>
            )}
          </button>
        )}
      >
        <div className="max-h-56 overflow-y-auto">
          {cycles.map((option) => (
            <DropdownItem
              key={option.id}
              icon={<CalendarClock className="size-3.5" />}
              {...(option.id === cycle?.id ? { trailing: <Check className="size-3.5" /> } : {})}
              onSelect={() => assign(option.id)}
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate">{option.label}</span>
                <span
                  className={cn(
                    'shrink-0 text-[11px]',
                    option.state === 'active' ? 'text-[var(--color-link)]' : 'text-faint'
                  )}
                >
                  {tracker(`cycleState.${option.state}`)}
                </span>
              </span>
            </DropdownItem>
          ))}
          {cycles.length === 0 && <p className="px-2 py-1.5 text-[12px] text-faint">{t('cycleNone')}</p>}
        </div>
        {cycle && (
          <>
            <DropdownSeparator />
            <DropdownItem icon={<X className="size-3.5" />} onSelect={() => assign(null)}>
              {t('cycleClear')}
            </DropdownItem>
          </>
        )}
      </DropdownMenu>
    </div>
  )
}
