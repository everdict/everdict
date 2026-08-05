import { Boxes } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import {
  DEFAULT_HARNESS_DISPLAY,
  HARNESS_FACETS,
  HARNESS_GROUPINGS,
  HARNESS_ORDERS,
  harnessesSchema,
} from '@/entities/harness'
import { membersSchema } from '@/entities/member'
import { scorecardsSchema } from '@/entities/scorecard'
import { teamsSchema, withResolvedTeamFilter, type Team } from '@/entities/team'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { buildHarnessRelations } from '@/shared/lib/harness-relations'
import { loadListViewScope } from '@/shared/lib/load-list-view'
import { buttonVariants } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { Link } from '@/shared/ui/link'
import { PageHeader } from '@/shared/ui/page-header'

import { HarnessList } from './harness-list'

// 등록된 하네스 목록 — 워크스페이스 하나의 주소다. 한동안 팀 아래에도 같은 목록이 있었지만(그 팀이 소유한
// 것), 그 축은 걷어냈다: 소유 팀은 남아서 "누가 고칠 수 있나"를 정하되 찾아가는 길은 하나이고, "우리 팀
// 것만"은 이 목록의 필터 한 축(team)이다.
//
// 서버가 하는 일은 컬렉션을 한 번 읽어 넘기는 것까지다 — 거르기·묶기·정렬은 전부 브라우저에서 일어난다.
// 이 목록들은 페이지네이션이 없어 컬렉션 전체가 손에 들어오므로, 필터를 바꿀 때마다 라우트를 다시 그릴
// 이유가 없다(그게 이슈 목록에서 "그룹 바꾸면 왜 이렇게 오래 걸리지"의 정체였다).
export async function HarnessListView({
  workspace,
  params,
}: {
  workspace: string
  params: Record<string, string | string[] | undefined>
}) {
  const { principal, ctx } = await currentPrincipal()
  const t = await getTranslations('harnessesPage')

  let error: string | undefined
  let harnesses = harnessesSchema.parse([])
  try {
    harnesses = harnessesSchema.parse(await controlPlane.listHarnesses(ctx))
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
  // 팀 축의 이름표 — 필터 메뉴에 uuid 를 늘어놓지 않기 위한 것이라, 실패하면 축만 조용히 사라진다.
  const teams = await controlPlane
    .listTeams(ctx)
    .then((r) => teamsSchema.parse(r))
    .catch((): Team[] => [])

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

  const scope = await loadListViewScope({
    basePath: `/${workspace}/harnesses`,
    viewKey: 'harnesses',
    facets: HARNESS_FACETS,
    vocabulary: {
      groupings: HARNESS_GROUPINGS,
      orders: HARNESS_ORDERS,
      fallback: DEFAULT_HARNESS_DISPLAY,
    },
    params,
  })

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
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
          teams={teams.map((team) => ({ id: team.id, key: team.key, name: team.name }))}
          scope={{ ...scope, filters: withResolvedTeamFilter(scope.filters, teams) }}
          canDelete={can(principal?.roles, 'harnesses:delete')}
        />
      )}
    </div>
  )
}
