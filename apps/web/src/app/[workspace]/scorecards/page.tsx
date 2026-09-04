import { ScorecardListView } from '@/widgets/scorecard-list'

export const dynamic = 'force-dynamic'

// The workspace's batch evaluation list — the same as harnesses. `?team=` is read as a FILTER on this list rather than as a path.
export default async function ScorecardsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { workspace } = await params
  return <ScorecardListView workspace={workspace} params={await searchParams} />
}
