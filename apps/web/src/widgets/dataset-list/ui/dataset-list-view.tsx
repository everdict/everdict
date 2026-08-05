import { Database } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import {
  DATASET_FACETS,
  DATASET_GROUPINGS,
  DATASET_ORDERS,
  datasetsSchema,
  DEFAULT_DATASET_DISPLAY,
} from '@/entities/dataset'
import { harnessesSchema } from '@/entities/harness'
import { membersSchema } from '@/entities/member'
import { scorecardsSchema } from '@/entities/scorecard'
import { teamsSchema, withResolvedTeamFilter, type Team } from '@/entities/team'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { buildDatasetRelations } from '@/shared/lib/dataset-relations'
import { loadListViewScope } from '@/shared/lib/load-list-view'
import { buttonVariants } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { Link } from '@/shared/ui/link'
import { PageHeader } from '@/shared/ui/page-header'

import { DatasetList } from './dataset-list'

// 평가 케이스 묶음 목록 — 하네스 목록과 같은 규칙이다. 워크스페이스 하나의 주소이고, 소유 팀은 필터 한 축이며,
// 거르기·묶기·정렬은 전부 브라우저에서 일어난다.
export async function DatasetListView({
  workspace,
  params,
}: {
  workspace: string
  params: Record<string, string | string[] | undefined>
}) {
  const { principal, ctx } = await currentPrincipal()
  const t = await getTranslations('datasetsPage')

  let error: string | undefined
  let datasets = datasetsSchema.parse([])
  try {
    datasets = datasetsSchema.parse(await controlPlane.listDatasets(ctx))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  // Related harnesses (derived from scorecards) + creator name (members join) are supplementary info — the list itself renders even if it fails.
  const scorecards = await controlPlane
    .listScorecards(ctx)
    .then((r) => scorecardsSchema.parse(r))
    .catch(() => [])
  const members = await controlPlane
    .listMembers(ctx)
    .then((r) => membersSchema.parse(r))
    .catch(() => [])
  // Live harness ids (soft-deleted tombstones excluded by GET /harnesses) — keep retired harnesses out of the
  // per-dataset "related harnesses" chips, matching the detail view. On fetch failure fall back to undefined
  // (no filtering) rather than an empty set, so a transient error doesn't blank out every chip.
  const liveHarnessIds = await controlPlane
    .listHarnesses(ctx)
    .then((r) => new Set(harnessesSchema.parse(r).map((h) => h.id)))
    .catch(() => undefined)
  // 팀 축의 이름표 — 실패하면 그 축만 조용히 사라진다.
  const teams = await controlPlane
    .listTeams(ctx)
    .then((r) => teamsSchema.parse(r))
    .catch((): Team[] => [])

  const relations = buildDatasetRelations(scorecards, liveHarnessIds)
  // For displaying the creator — subject → name + avatar (if any). Name is profile name > email local part > subject fallback.
  const authors: Record<string, { name: string; avatarUrl?: string }> = {}
  for (const m of members)
    authors[m.subject] = {
      name: m.name ?? m.email?.split('@')[0] ?? m.subject,
      ...(m.avatarUrl ? { avatarUrl: m.avatarUrl } : {}),
    }

  const currentWorkspace = principal?.workspace ?? workspace
  // Only expose datasets owned by this workspace — shared (first-party) benchmarks are handled in the 'add benchmark'/recipe flow.
  const ownDatasets = datasets.filter((d) => d.owner === currentWorkspace)

  const scope = await loadListViewScope({
    basePath: `/${workspace}/datasets`,
    viewKey: 'datasets',
    facets: DATASET_FACETS,
    vocabulary: {
      groupings: DATASET_GROUPINGS,
      orders: DATASET_ORDERS,
      fallback: DEFAULT_DATASET_DISPLAY,
    },
    params,
  })

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          can(principal?.roles, 'datasets:write') ? (
            <div className="flex gap-2">
              <Link
                href={`/${workspace}/datasets/import`}
                className={buttonVariants({ size: 'sm', variant: 'secondary' })}
              >
                {t('importFromSource')}
              </Link>
              <Link href={`/${workspace}/datasets/new`} className={buttonVariants({ size: 'sm' })}>
                {t('register')}
              </Link>
            </div>
          ) : null
        }
      />
      {error ? (
        <Callout tone="danger">{t('connectError', { error })}</Callout>
      ) : ownDatasets.length === 0 ? (
        <EmptyState icon={<Database />} title={t('emptyTitle')} hint={t('emptyHint')} />
      ) : (
        <DatasetList
          workspace={workspace}
          datasets={ownDatasets}
          relations={relations}
          authors={authors}
          teams={teams.map((team) => ({ id: team.id, key: team.key, name: team.name }))}
          scope={{ ...scope, filters: withResolvedTeamFilter(scope.filters, teams) }}
        />
      )}
    </div>
  )
}
