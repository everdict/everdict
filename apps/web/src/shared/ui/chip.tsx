import type { ReactNode } from 'react'

import { fmtPct } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'

// 메트릭 요약 칩 — 이름(faint) + 평균 + 선택적 통과율. 목록/하니스별에서 동일하게.
export function MetricChip({
  metric,
  mean,
  passRate,
}: {
  metric: string
  mean: number
  passRate?: number | null
}) {
  return (
    <code className="inline-flex items-center gap-1 rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px]">
      <span className="text-faint">{metric}</span>
      <span className="tabular-nums text-foreground/85">{mean.toFixed(2)}</span>
      {passRate != null && <span className="tabular-nums text-faint">· {fmtPct(passRate)}</span>}
    </code>
  )
}

// 모델 칩 — 하니스가 쓴/선언한 LLM 식별자. primary=bg-secondary(강조), muted=관측/선언(옅음). 전역 통일.
export function ModelChip({ children, muted }: { children: ReactNode; muted?: boolean }) {
  return (
    <code
      className={cn(
        'rounded border border-border px-1.5 py-0.5 font-mono text-[11px]',
        muted ? 'bg-muted/40 text-muted-foreground' : 'bg-secondary text-secondary-foreground'
      )}
    >
      {children}
    </code>
  )
}

// id@version 참조 — 데이터셋/하니스 식별을 동일 서식으로(@version 은 faint).
export function EntityRef({ id, version }: { id: string; version?: string }) {
  return (
    <span className="font-mono">
      {id}
      {version && <span className="text-faint">@{version}</span>}
    </span>
  )
}
