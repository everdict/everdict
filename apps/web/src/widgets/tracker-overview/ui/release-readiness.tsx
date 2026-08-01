import Link from 'next/link'
import { CheckCircle2, Rocket, TriangleAlert } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import type { InitiativeDetail } from '@/entities/initiative'
import { issueHref, IssueStatusIcon } from '@/entities/issue'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { Card } from '@/shared/ui/card'

// 배포 준비도 — 오버뷰가 가장 먼저 답해야 하는 질문("내보내도 되나"). 이니셔티브의 readiness 는 취소되지 않은 모든
// 프로젝트의 열린 이슈를 세므로, completed 프로젝트 안의 regressed 이슈도 여기서 막힌 것으로 나타난다.
// blocker 는 서버가 이미 회귀 먼저로 정렬해 보내준다.
const BLOCKER_PREVIEW = 3

function ReadinessBar({ done, total }: { done: number; total: number }) {
  const pct = total === 0 ? 100 : Math.round((done / total) * 100)
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
      <div
        className={cn(
          'h-full rounded-full transition-all',
          pct === 100 ? 'bg-[var(--color-success)]' : 'bg-primary'
        )}
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

export async function ReleaseReadiness({
  workspace,
  initiatives,
}: {
  workspace: string
  initiatives: InitiativeDetail[]
}) {
  const t = await getTranslations('overviewPage')
  return (
    <div className="grid grid-cols-1 gap-2.5 @2xl:grid-cols-2">
      {initiatives.map((initiative) => {
        const { readiness } = initiative
        const resolved = readiness.totalIssues - readiness.openIssues
        return (
          <Card key={initiative.id} className="@container flex flex-col gap-3 p-4">
            <div className="flex items-start justify-between gap-3">
              <Link
                href={`/${workspace}/initiatives/${initiative.id}`}
                className="group flex min-w-0 items-center gap-2"
              >
                <Rocket className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                <span className="truncate text-[13.5px] font-[560] text-foreground group-hover:underline">
                  {initiative.name}
                </span>
              </Link>
              <Badge tone={readiness.ready ? 'success' : 'warning'}>
                {readiness.ready ? (
                  <>
                    <CheckCircle2 className="size-3" strokeWidth={2} />
                    {t('readinessReady')}
                  </>
                ) : (
                  <>
                    <TriangleAlert className="size-3" strokeWidth={2} />
                    {t('readinessBlocked', { count: readiness.openIssues })}
                  </>
                )}
              </Badge>
            </div>

            <div className="space-y-1.5">
              <ReadinessBar done={resolved} total={readiness.totalIssues} />
              <p className="text-[11.5px] text-muted-foreground">
                {t('readinessProgress', {
                  resolved,
                  total: readiness.totalIssues,
                  projects: readiness.projects.length,
                })}
              </p>
            </div>

            {readiness.blockers.length > 0 && (
              <ul className="space-y-1 border-t pt-2.5">
                {readiness.blockers.slice(0, BLOCKER_PREVIEW).map((blocker) => (
                  <li key={blocker.issueId}>
                    <Link
                      href={issueHref(workspace, blocker.identifier)}
                      className="group flex items-center gap-2 text-[12.5px] text-secondary-foreground hover:text-foreground"
                    >
                      <IssueStatusIcon status={blocker.status} className="size-3.5 shrink-0" />
                      <span className="truncate group-hover:underline">{blocker.title}</span>
                    </Link>
                  </li>
                ))}
                {readiness.blockers.length > BLOCKER_PREVIEW && (
                  <li className="pl-[22px] text-[11.5px] text-faint">
                    {t('readinessMoreBlockers', {
                      count: readiness.blockers.length - BLOCKER_PREVIEW,
                    })}
                  </li>
                )}
              </ul>
            )}
          </Card>
        )
      })}
    </div>
  )
}
