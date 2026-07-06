import type { ReactNode } from 'react'

import {
  classifyImageRef,
  IMAGE_CLASS_HINT,
  IMAGE_CLASS_LABEL,
  type ImageRegistryCoordinates,
} from '@/shared/lib/image-ref'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'

// inspect-harness 뷰 공통 프리미티브 — 라벨/값 필드, 모노 칩, 라벨 섹션.

// 이미지 출처 배지 — 워크스페이스 레지스트리(파랑)/로컬 전용·미지정(경고). external 은 기본 상태라 배지 없음(소음 방지).
// hint 는 title 로(이미지 ref 자체가 이미 title 을 쓰는 관례와 동일). 분류 SSOT 는 컨트롤플레인, 여기는 표시용 미러.
export function ImageClassBadge({
  image,
  registry,
}: {
  image: string
  registry?: ImageRegistryCoordinates
}) {
  const cls = classifyImageRef(image, registry)
  if (cls === 'external') return null
  return (
    <Badge tone={cls === 'workspace' ? 'info' : 'warning'} title={IMAGE_CLASS_HINT[cls]}>
      {IMAGE_CLASS_LABEL[cls]}
    </Badge>
  )
}

export function Field({
  label,
  value,
  mono = true,
  className,
}: {
  label: ReactNode
  value: ReactNode
  mono?: boolean
  className?: string
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <dt className="text-[10.5px] font-[510] uppercase tracking-wide text-faint">{label}</dt>
      <dd
        className={cn(
          'mt-1 truncate text-[13px] text-foreground',
          mono && 'font-mono text-[12.5px]'
        )}
      >
        {value}
      </dd>
    </div>
  )
}

// 라벨(좁은 왼칸) + 값(채움) 한 줄 — 반응형 그리드 셀. wide=전체 폭(명령처럼 긴 값). 패딩은 그리드 gap 이 담당.
export function DefRow({
  label,
  children,
  mono = false,
  wide = false,
}: {
  label: ReactNode
  children: ReactNode
  mono?: boolean
  wide?: boolean
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-4',
        wide && 'col-span-full'
      )}
    >
      <span className="shrink-0 text-[11px] font-[510] uppercase tracking-wide text-faint sm:w-20">
        {label}
      </span>
      <div
        className={cn(
          'min-w-0 flex-1 text-[13px] text-foreground',
          mono && 'break-all font-mono text-[12.5px]'
        )}
      >
        {children}
      </div>
    </div>
  )
}

// 명령 템플릿의 {{task}}/{{model}}/{{run_id}} 자리표시자를 강조 분리(순수). command 뷰에서 사용.
export function highlightTemplate(command: string): ReactNode[] {
  return command.split(/(\{\{[^}]+\}\})/g).map((part, i) =>
    /^\{\{[^}]+\}\}$/.test(part) ? (
      <span
        key={i}
        className="rounded bg-primary/15 px-1 text-[var(--color-accent-foreground)] ring-1 ring-inset ring-primary/25"
      >
        {part}
      </span>
    ) : (
      <span key={i}>{part}</span>
    )
  )
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <code
      className={cn(
        'rounded bg-secondary px-1.5 py-0.5 font-mono text-[12px] text-muted-foreground ring-1 ring-inset ring-border',
        className
      )}
    >
      {children}
    </code>
  )
}

export function SubSection({
  title,
  icon,
  count,
  children,
}: {
  title: ReactNode
  icon?: ReactNode
  count?: number
  children: ReactNode
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        {icon && <span className="text-muted-foreground">{icon}</span>}
        <h3 className="text-[13px] font-[560] tracking-[-0.01em] text-foreground">{title}</h3>
        {count !== undefined && (
          <span className="rounded-full bg-secondary px-1.5 py-0.5 text-[10.5px] font-[510] tabular-nums text-muted-foreground ring-1 ring-inset ring-border">
            {count}
          </span>
        )}
      </div>
      {children}
    </section>
  )
}
