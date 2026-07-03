import Link from 'next/link'

import { ScorecardList } from '@/widgets/scorecard-list'
import { membersSchema } from '@/entities/member'
import { scorecardsSchema } from '@/entities/scorecard'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { buttonVariants } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

export default async function ScorecardsPage({
  params,
}: {
  params: Promise<{ workspace: string }>
}) {
  const { workspace } = await params
  const { principal, ctx } = await currentPrincipal()
  let error: string | undefined
  let scorecards = scorecardsSchema.parse([])
  try {
    scorecards = scorecardsSchema.parse(await controlPlane.listScorecards(ctx))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  // 실행자 이름(members 조인)은 부가 정보 — 실패해도 목록 자체는 보인다. (데이터셋 목록과 동일 패턴)
  const members = await controlPlane
    .listMembers(ctx)
    .then((r) => membersSchema.parse(r))
    .catch(() => [])

  // 실행자 표기용 — subject → 이름 + 아바타(있으면). 이름은 프로필 name > email 로컬파트 > subject 폴백.
  const authors: Record<string, { name: string; avatarUrl?: string }> = {}
  for (const m of members)
    authors[m.subject] = {
      name: m.name ?? m.email?.split('@')[0] ?? m.subject,
      ...(m.avatarUrl ? { avatarUrl: m.avatarUrl } : {}),
    }

  const canRun = can(principal?.roles, 'scorecards:run')

  return (
    <div className="space-y-6">
      <PageHeader
        title="스코어카드"
        description="벤치마크로 하니스를 한 번에 평가하고 점수를 모아 봐요."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={`/${workspace}/scorecards/analyze`}
              className={buttonVariants({ size: 'sm', variant: 'secondary' })}
            >
              분석
            </Link>
            {canRun ? (
              <>
                <Link
                  href={`/${workspace}/scorecards/ingest`}
                  className={buttonVariants({ size: 'sm', variant: 'secondary' })}
                >
                  트레이스 올리기
                </Link>
                <Link
                  href={`/${workspace}/scorecards/new`}
                  className={buttonVariants({ size: 'sm' })}
                >
                  스코어카드 실행
                </Link>
              </>
            ) : null}
          </div>
        }
      />

      {error ? (
        <Callout tone="danger">서버에 연결하지 못했어요: {error}</Callout>
      ) : scorecards.length === 0 ? (
        <EmptyState
          title="아직 스코어카드가 없어요."
          hint="'스코어카드 실행'으로 하니스를 평가해보세요."
        />
      ) : (
        <ScorecardList workspace={workspace} scorecards={scorecards} authors={authors} />
      )}
    </div>
  )
}
