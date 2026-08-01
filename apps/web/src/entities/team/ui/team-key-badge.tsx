import { cn } from '@/shared/lib/utils'

// 팀 키 칩 — `ENG`. 사이드바·설정 목록·이슈 행이 같은 모양을 쓰도록 한 곳에 둔다.
// 식별자(`ENG-12`)는 이슈 레코드가 이미 문자열로 들고 있으므로 여기서 조립하지 않는다.
export function TeamKeyBadge({ teamKey, className }: { teamKey: string; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wide text-muted-foreground',
        className
      )}
    >
      {teamKey}
    </span>
  )
}
