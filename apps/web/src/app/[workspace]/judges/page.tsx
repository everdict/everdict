import { JudgeListView } from '@/widgets/judge-list'

export const dynamic = 'force-dynamic'

// 워크스페이스의 Agent Judge 목록 — 하네스와 같다. `?team=` 은 이 목록의 필터로 읽힌다.
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
