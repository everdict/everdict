import { HarnessListView } from '@/widgets/harness-list'

export const dynamic = 'force-dynamic'

// 워크스페이스의 하네스 목록 — 유일한 주소다. 소유 팀으로 좁히는 것은 이 목록의 필터이므로, 팀 축이 경로였던
// 시절의 `?team=` 링크도 그대로 열린다: 같은 이름의 쿼리 파라미터가 이제 그 필터의 철자다.
export default async function HarnessesPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { workspace } = await params
  return <HarnessListView workspace={workspace} params={await searchParams} />
}
