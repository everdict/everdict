import { ScorecardListView } from '@/widgets/scorecard-list'

export const dynamic = 'force-dynamic'

// 워크스페이스의 배치 평가 목록 — 하네스와 같다. `?team=` 은 경로가 아니라 이 목록의 필터로 읽힌다.
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
