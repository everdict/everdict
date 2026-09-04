import { ArrowRight } from 'lucide-react'

import { InitiativeStatusBadge, initiativeStatusSchema } from '@/entities/initiative'
import { IssueStatusBadge, issueStatusSchema } from '@/entities/issue'
import { ProjectStatusBadge, projectStatusSchema } from '@/entities/project'
import { Badge } from '@/shared/ui/badge'

// A tracker record with a history. The status vocabulary differs per kind (issue 7 · project 4 · initiative 3), so it is used only for
// choosing the status chip.
export type TrackerKind = 'issue' | 'cycle' | 'project' | 'initiative'

// The status chip is the SAME badge the lists and details use — a different shape only in the history would make one status look different per screen.
// The value is unvalidated free text (a history detail, a platform event payload), so a string outside the vocabulary falls back to a raw chip.
// This file has no hooks and no 'use client' — so the tracker history (a client island) and the home activity feed (a server
// component) draw the same one set of chips.
export function TrackerStatusChip({ kind, value }: { kind: TrackerKind; value: string }) {
  if (kind === 'issue') {
    const parsed = issueStatusSchema.safeParse(value)
    if (parsed.success) return <IssueStatusBadge status={parsed.data} />
  }
  if (kind === 'project') {
    const parsed = projectStatusSchema.safeParse(value)
    if (parsed.success) return <ProjectStatusBadge status={parsed.data} />
  }
  if (kind === 'initiative') {
    const parsed = initiativeStatusSchema.safeParse(value)
    if (parsed.success) return <InitiativeStatusBadge status={parsed.data} />
  }
  return <Badge tone="outline">{value}</Badge>
}

// from → to. Where it MOVED TO is the conclusion, so it goes after the arrow. When only one side reads, only that side is drawn.
export function TrackerStatusMove({
  kind,
  from,
  to,
}: {
  kind: TrackerKind
  from: string | undefined
  to: string | undefined
}) {
  if (from === undefined && to === undefined) return null
  return (
    <span className="inline-flex items-center gap-1">
      {from !== undefined && <TrackerStatusChip kind={kind} value={from} />}
      {from !== undefined && to !== undefined && (
        <ArrowRight className="size-3 shrink-0 text-faint" aria-hidden />
      )}
      {to !== undefined && <TrackerStatusChip kind={kind} value={to} />}
    </span>
  )
}
