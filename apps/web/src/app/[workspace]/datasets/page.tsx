import { DatasetListView } from '@/widgets/dataset-list'

export const dynamic = 'force-dynamic'

// 워크스페이스의 데이터셋 목록 — 하네스와 같다. `?team=` 은 경로가 아니라 이 목록의 필터로 읽힌다.
export default async function DatasetsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { workspace } = await params
  return <DatasetListView workspace={workspace} params={await searchParams} />
}
