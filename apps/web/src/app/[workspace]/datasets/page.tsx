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
  const authors: Record<string, string> = {}
  for (const m of members) authors[m.subject] = m.name ?? m.email ?? m.subject

  const currentWorkspace = principal?.workspace ?? workspace

  return (
    <div className="space-y-6">
      <PageHeader
        title="데이터셋"
        description="하니스 무관 eval 케이스 묶음 — 어느 하니스든 같은 케이스로 평가하고 버전으로 비교"
        actions={
          can(principal?.roles, 'datasets:write') ? (
            <div className="flex gap-2">
              <Link
                href={`/${workspace}/recipes`}
                className={buttonVariants({ size: 'sm', variant: 'secondary' })}
              >
                레시피
              </Link>
              <Link
                href={`/${workspace}/datasets/import`}
                className={buttonVariants({ size: 'sm', variant: 'secondary' })}
              >
                벤치마크 추가
              </Link>
              <Link href={`/${workspace}/datasets/new`} className={buttonVariants({ size: 'sm' })}>
                데이터셋 등록
              </Link>
            </div>
          ) : null
        }
      />
      {error ? (
        <Callout tone="danger">컨트롤플레인 연결 실패: {error}</Callout>
      ) : datasets.length === 0 ? (
        <EmptyState
          icon={<Database />}
          title="등록된 데이터셋이 없습니다."
          hint="member 이상이면 '데이터셋 등록'으로 eval 케이스 묶음을 올리거나, '벤치마크 추가'로 소스에서 만들거나, API/MCP(create_dataset)로 등록하세요."
        />
      ) : (
        <DatasetList
          workspace={workspace}
          currentWorkspace={currentWorkspace}
          datasets={datasets}
          relations={relations}
          authors={authors}
        />
      )}
    </div>
  )
}
