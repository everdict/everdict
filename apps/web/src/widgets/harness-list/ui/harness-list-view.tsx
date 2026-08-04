import Link from 'next/link'
import { Boxes } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import { TeamScopeBar, type TeamScope } from '@/widgets/team-scope-bar'
import { harnessesSchema } from '@/entities/harness'
import { membersSchema } from '@/entities/member'
import { scorecardsSchema } from '@/entities/scorecard'
import type { TeamWithSummary } from '@/entities/team'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { buildHarnessRelations } from '@/shared/lib/harness-relations'
import { buttonVariants } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

import { HarnessList } from './harness-list'

// 등록된 하네스 목록. ONE component behind TWO addresses: `/{workspace}/harnesses` (워크스페이스 전체)와
// `/{workspace}/teams/ENG/harnesses` (그 팀이 소유한 것). 소유권이 읽기에 하는 일은 필터이지 403 이 아니므로
// 팀 밖에서도 계속 보이고, 팀 주소는 "우리 팀은 무엇으로 평가하나"에 답한다.
export async function HarnessListView({
  workspace,
  team,
}: {
  workspace: string
  team?: TeamWithSummary
}) {
  const { principal, ctx } = await currentPrincipal()
  const t = await getTranslations('harnessesPage')

  let error: string | undefined
  let harnesses = harnessesSchema.parse([])
  try {
    harnesses = harnessesSchema.parse(await controlPlane.listHarnesses(ctx, team?.id))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  // Run benchmarks (derived from scorecards) + registrant (members join) are supplementary info — the list shows up even if it fails.
  const scorecards = await controlPlane
    .listScorecards(ctx)
    .then((r) => scorecardsSchema.parse(r))
    .catch(() => [])
  const members = await controlPlane
    .listMembers(ctx)
    .then((r) => membersSchema.parse(r))
    .catch(() => [])

  const relations = buildHarnessRelations(scorecards)
  const authors: Record<string, { name: string; avatarUrl?: string }> = {}
  for (const m of members)
    authors[m.subject] = {
      name: m.name ?? m.email?.split('@')[0] ?? m.subject,
      ...(m.avatarUrl ? { avatarUrl: m.avatarUrl } : {}),
    }

  const currentWorkspace = principal?.workspace ?? workspace
  // Only expose harnesses registered by this workspace — shared (first-party) harnesses are excluded from the list.
  const ownHarnesses = harnesses.filter((h) => h.owner === currentWorkspace)
  const scope: TeamScope | undefined = team ? { workspace, team, section: 'harnesses' } : undefined

  return (
    <div className="space-y-6">
      {scope && <TeamScopeBar scope={scope} />}
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          // 등록은 팀 주소에서도 같은 워크스페이스 폼으로 간다 — 하네스에는 아직 스코어카드의
          // `…/scorecards/new` 같은 팀 못 박기 주소가 없어서(위자드가 `teamId` 를 싣지 않는다) 소유 팀은
          // 제어 평면이 정한다. 그렇다고 팀 화면에서 버튼을 빼면 "첫 하네스를 등록해보세요"라는 빈 화면이
          // 누를 것 없는 안내가 된다.
          <div className="flex items-center gap-3">
            {/* 형상 카탈로그로 — "무엇으로 평가하는가"(여기)와 "어떤 형상이 있는가"는 다른 질문이다. */}
            <Link
              href={`/${workspace}/harness-templates`}
              className="text-[12px] font-[510] text-link transition-colors hover:text-foreground"
            >
              {t('shapesLink')}
            </Link>
            {can(principal?.roles, 'harnesses:register') ? (
              <Link href={`/${workspace}/harnesses/new`} className={buttonVariants({ size: 'sm' })}>
                {t('register')}
              </Link>
            ) : null}
          </div>
        }
      />
      {error ? (
        <Callout tone="danger">{t('connectError', { error })}</Callout>
      ) : ownHarnesses.length === 0 ? (
        <EmptyState icon={<Boxes />} title={t('emptyTitle')} hint={t('emptyHint')} />
      ) : (
        <HarnessList
          workspace={workspace}
          harnesses={ownHarnesses}
          relations={relations}
          authors={authors}
          canDelete={can(principal?.roles, 'harnesses:delete')}
        />
      )}
    </div>
  )
}
