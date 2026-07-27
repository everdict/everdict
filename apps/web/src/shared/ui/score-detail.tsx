import type { ReactNode } from 'react'

import { classifyScoreDetail } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { JsonTree } from '@/shared/ui/json-view'

// A grader/judge verdict's `detail` — prose OR a structured verdict object. Code judges and the store-state grader
// emit objects (e.g. `{ actual, expected }`); these used to flatten to an unreadable one-line JSON string, so a
// structured detail now renders as a collapsible, syntax-highlighted JSON tree. Prose stays verbatim, with whitespace
// preserved so multi-line command/log output keeps its shape. Renders null when there is no detail to show.
//
// `header` is an optional label (the metric label) — shown as a header row above the JSON tree, or inline before the
// prose. `indented` nudges a criterion row under its judge's overall verdict. The classification lives in
// `classifyScoreDetail` (shared/lib/format) so it stays pure/testable.
export function ScoreDetail({
  detail,
  header,
  indented,
  className,
}: {
  detail: unknown
  header?: ReactNode
  indented?: boolean
  className?: string
}) {
  const view = classifyScoreDetail(detail)
  if (!view) return null

  if (view.kind === 'json')
    return (
      <div
        className={cn(
          'overflow-hidden rounded-lg border border-border bg-muted/40',
          indented && 'ml-5',
          className
        )}
      >
        {header != null && (
          <div className="border-b border-border px-3 py-2 text-[12px]">{header}</div>
        )}
        <JsonTree value={view.value} className="max-h-96 p-3 text-[11.5px] leading-[1.65]" />
      </div>
    )

  return (
    <p
      className={cn(
        'whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/40 px-3 py-2 text-[12px] leading-relaxed text-muted-foreground',
        indented && 'ml-5',
        className
      )}
    >
      {header != null && <>{header} · </>}
      {view.text}
    </p>
  )
}
