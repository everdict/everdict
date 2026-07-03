import Link from 'next/link'
import { Database } from 'lucide-react'

import { DatasetList } from '@/widgets/dataset-list'
import { datasetsSchema } from '@/entities/dataset'
import { membersSchema } from '@/entities/member'
import { scorecardsSchema } from '@/entities/scorecard'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { buildDatasetRelations } from '@/shared/lib/dataset-relations'
import { buttonVariants } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

export default async function DatasetsPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace } = await params
  const { principal, ctx } = await currentPrincipal()

  let error: string | undefined
  let datasets = datasetsSchema.parse([])
  try {
    datasets = datasetsSchema.parse(await controlPlane.listDatasets(ctx))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  // 관계 하니스(스코어카드에서 도출) + 만든이 이름(members 조인)은 부가 정보 — 실패해도 목록 자체는 보인다.
  const scorecards = await controlPlane
    .listScorecards(ctx)
    .then((r) => scorecardsSchema.parse(r))
    .catch(() => [])
  const members = await controlPlane
    .listMembers(ctx)
    .then((r) => membersSchema.parse(r))
    .catch(() => [])

  const relations = buildDatasetRelations(scorecards)
  // 만든이 표기용 — subject → 이름 + 아바타(있으면). 이름은 프로필 name > email 로컬파트 > subject 폴백.
  const authors: Record<string, { name: string; avatarUrl?: string }> = {}
  for (const m of members)
    authors[m.subject] = {
      name: m.name ?? m.email?.split('@')[0] ?? m.subject,
      ...(m.avatarUrl ? { avatarUrl: m.avatarUrl } : {}),
    }

  const currentWorkspace = principal?.workspace ?? workspace
  // 이 워크스페이스가 소유한 데이터셋만 노출 — 공유(first-party) 벤치마크는 '벤치마크 추가'/레시피 흐름에서 다룬다.
  const ownDatasets = datasets.filter((d) => d.owner === currentWorkspace)

  return (
    <div className="space-y-6">
      <PageHeader
        title="벤치마크"
        description="어떤 하니스든 같은 문제로 공정하게 비교해요."
        actions={
          can(principal?.roles, 'datasets:write') ? (
            <div className="flex gap-2">
              <Link
                href={`/${workspace}/datasets/import`}
                className={buttonVariants({ size: 'sm', variant: 'secondary' })}
              >
                소스에서 가져오기
              </Link>
              <Link href={`/${workspace}/datasets/new`} className={buttonVariants({ size: 'sm' })}>
                벤치마크 등록
              </Link>
            </div>
          ) : null
        }
      />
      {error ? (
        <Callout tone="danger">서버에 연결하지 못했어요: {error}</Callout>
      ) : ownDatasets.length === 0 ? (
        <EmptyState
          icon={<Database />}
          title="아직 벤치마크가 없어요."
          hint="첫 벤치마크를 만들어보세요. 직접 올리거나 소스에서 가져올 수 있어요."
        />
      ) : (
        <DatasetList
          workspace={workspace}
          datasets={ownDatasets}
          relations={relations}
          authors={authors}
        />
      )}
    </div>
  )
}
