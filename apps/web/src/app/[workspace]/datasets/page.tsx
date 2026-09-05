import { DatasetListView } from '@/widgets/dataset-list'

export const dynamic = 'force-dynamic'

// The workspace's dataset list — the same as harnesses. `?team=` is read as a FILTER on this list rather than as a path.
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
