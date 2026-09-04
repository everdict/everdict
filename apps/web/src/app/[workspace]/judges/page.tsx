import { JudgeListView } from '@/widgets/judge-list'

export const dynamic = 'force-dynamic'

// The workspace's Agent Judge list — the same as harnesses. `?team=` is read as a filter on this list.
export default async function JudgesPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { workspace } = await params
  return <JudgeListView workspace={workspace} params={await searchParams} />
}
