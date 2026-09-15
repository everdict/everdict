import { JudgeListView } from '@/widgets/judge-list'

export const dynamic = 'force-dynamic'

// The workspace's Agent Judge list — the only address, the same as harnesses.
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
