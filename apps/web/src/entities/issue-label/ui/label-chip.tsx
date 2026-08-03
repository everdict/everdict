import { cn } from '@/shared/lib/utils'

import type { IssueLabel, IssueLabelColor } from '../model/schema'

// Linear st. 라벨 칩 — 색 점 + 이름. 색은 닫힌 어휘(contracts ISSUE_LABEL_COLORS)이고 여기서 테마 토큰으로
// 매핑한다: hex 를 저장했다면 다크에서 안 보이는 라벨을 누구나 만들 수 있었을 것이다. 차트와 같은 규칙 —
// 지어낸 색은 없다.
//
// `bg-<token>/x` 는 우리 @theme inline 색에서는 유틸리티를 만들지 않는다(shadcn 의 destructive 와 다름) —
// 그래서 점은 CSS 변수를 직접 읽는다(shared/ui/badge 와 같은 회피법).
const DOT: Record<IssueLabelColor, string> = {
  gray: 'var(--color-muted-foreground)',
  purple: 'var(--chart-4)',
  blue: 'var(--color-primary)',
  teal: 'var(--chart-5)',
  green: 'var(--color-success)',
  yellow: 'var(--color-warning)',
  orange: 'var(--chart-3)',
  red: 'var(--color-destructive)',
  pink: 'var(--chart-2)',
}

export function LabelDot({ color, className }: { color: IssueLabelColor; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('size-2 shrink-0 rounded-full', className)}
      style={{ backgroundColor: DOT[color] }}
    />
  )
}

export function LabelChip({ label, className }: { label: IssueLabel; className?: string }) {
  return (
    <span
      title={label.description ?? label.name}
      className={cn(
        'inline-flex min-w-0 items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-[11.5px] text-muted-foreground',
        className
      )}
    >
      <LabelDot color={label.color} />
      <span className="truncate">{label.name}</span>
    </span>
  )
}

// 이슈가 든 id 를 레지스트리에 붙여 칩으로 그린다. 정의가 사라진 id 는 렌더하지 않는다 — 삭제가 이슈에서
// id 를 같이 떼어내므로 정상 경로에서는 생기지 않고, 생겼다면 그건 표시할 것이 없는 포인터다.
export function IssueLabelChips({
  labelIds,
  directory,
  className,
}: {
  labelIds: string[]
  directory: Record<string, IssueLabel>
  className?: string
}) {
  const resolved = labelIds.map((id) => directory[id]).filter((l): l is IssueLabel => l !== undefined)
  if (resolved.length === 0) return null
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1', className)}>
      {resolved.map((label) => (
        <LabelChip key={label.id} label={label} />
      ))}
    </span>
  )
}
