import { cn } from '@/shared/lib/utils'

// Linear st. 토글 — 설정 한 줄의 켬/끔은 스위치다. 「켜짐」이라 적힌 버튼은 그것이 *지금 상태*인지 *누르면
// 될 일*인지 말해 주지 않아서, 한 화면에 여럿 놓이는 순간 전부 다시 읽어야 한다. 스위치는 위치가 곧 상태다.
//
// 스위치는 즉시 적용되는 컨트롤이다 — 저장 버튼을 기다리는 스위치는 이미 켜진 것처럼 보이면서 켜지지 않은
// 상태를 만든다. 호출부는 `onCheckedChange` 에서 바로 서버 액션을 부르고, 실패를 토스트로 알린다.
export function Switch({
  checked,
  onCheckedChange,
  disabled,
  id,
  'aria-label': ariaLabel,
  'aria-describedby': ariaDescribedBy,
}: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  id?: string
  'aria-label'?: string
  'aria-describedby'?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        'relative inline-flex h-[18px] w-[30px] shrink-0 cursor-pointer items-center rounded-full p-px transition-colors duration-150 ease-[var(--ease-out-cubic)] outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-default disabled:opacity-45',
        checked ? 'bg-primary' : 'bg-muted-foreground/35'
      )}
    >
      <span
        className={cn(
          'size-4 rounded-full bg-white shadow-[0_1px_2px_rgba(8,9,10,0.35)] transition-transform duration-150 ease-[var(--ease-out-cubic)]',
          checked ? 'translate-x-3' : 'translate-x-0'
        )}
      />
    </button>
  )
}
