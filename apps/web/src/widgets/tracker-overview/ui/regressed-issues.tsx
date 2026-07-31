import Link from 'next/link'
import { getFormatter } from 'next-intl/server'

import type { Issue } from '@/entities/issue'
import { Card } from '@/shared/ui/card'

// 회귀 경보 — 닫아둔 이슈의 평가가 무너진 것들. 아무도 안 보고 있는 이슈라서 홈이 대신 들이민다.
// 비어 있으면 섹션째 렌더하지 않는다(빈 섹션 숨김 규칙) — "회귀 없음" 카드는 매일 보면 노이즈가 된다.
export async function RegressedIssues({
  workspace,
  issues,
}: {
  workspace: string
  issues: Issue[]
}) {
  const format = await getFormatter()
  return (
    <Card className="divide-y overflow-hidden p-0">
      {issues.map((issue) => (
        <Link
          key={issue.id}
          href={`/${workspace}/issues/${issue.id}`}
          className="group flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-elevated"
        >
          <span className="size-1.5 shrink-0 rounded-full bg-destructive" />
          <span className="min-w-0 flex-1 truncate text-[13px] font-[510] text-foreground group-hover:underline">
            {issue.title}
          </span>
          {/* 회귀를 적발한 스코어카드가 resolution 에 남아 있다 — 근거로 바로 들어갈 수 있게 노출한다. */}
          {issue.resolution?.scorecardId && (
            <span className="hidden shrink-0 font-mono text-[11px] text-faint @lg:inline">
              {issue.resolution.scorecardId.slice(0, 8)}
            </span>
          )}
          <time className="shrink-0 text-[11.5px] text-muted-foreground" dateTime={issue.updatedAt}>
            {format.relativeTime(new Date(issue.updatedAt))}
          </time>
        </Link>
      ))}
    </Card>
  )
}
