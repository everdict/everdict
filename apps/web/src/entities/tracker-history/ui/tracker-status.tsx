import { ArrowRight } from 'lucide-react'

import { InitiativeStatusBadge, initiativeStatusSchema } from '@/entities/initiative'
import { IssueStatusBadge, issueStatusSchema } from '@/entities/issue'
import { ProjectStatusBadge, projectStatusSchema } from '@/entities/project'
import { Badge } from '@/shared/ui/badge'

// 이력을 가진 트래커 레코드. 상태 어휘가 종류마다 달라(이슈 7 · 프로젝트 4 · 이니셔티브 3) 상태 칩을
// 고를 때만 쓰인다.
export type TrackerKind = 'issue' | 'cycle' | 'project' | 'initiative'

// 상태 칩은 목록·상세에서 쓰는 그 배지 그대로다 — 이력에서만 다른 모양을 쓰면 같은 상태가 화면마다 달라진다.
// 값은 검증되지 않은 자유 값이라(이력 detail·플랫폼 이벤트 payload), 어휘에 없는 문자열은 원문 칩으로
// 떨어진다. 이 파일에는 훅도 'use client' 도 없다 — 트래커 이력(클라이언트 섬)과 홈 활동 피드(서버
// 컴포넌트)가 같은 칩 한 벌을 그리기 위해서다.
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

// from → to. 옮겨 간 쪽(to)이 결론이라 화살표 뒤에 둔다. 한쪽만 읽히면 그 한쪽만 그린다.
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
