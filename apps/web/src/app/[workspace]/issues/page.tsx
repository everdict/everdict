import { IssueListView, type IssueListFilters } from '@/widgets/issue-list'

export const dynamic = 'force-dynamic'

// 워크스페이스 전체의 이슈 — 워크스페이스가 유일한 경계이므로 주소도 하나다.
export default async function IssuesPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>
  searchParams: Promise<IssueListFilters>
}) {
  const { workspace } = await params
  const search = await searchParams
  return <IssueListView workspace={workspace} filters={search} />
}
