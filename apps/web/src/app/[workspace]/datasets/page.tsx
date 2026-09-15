import { DatasetListView } from '@/widgets/dataset-list'

export const dynamic = 'force-dynamic'

// The workspace's dataset list — the only address, the same as harnesses.
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
