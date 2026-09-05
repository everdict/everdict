import { IssueListView, type IssueListFilters } from '@/widgets/issue-list'

export const dynamic = 'force-dynamic'

// Every issue in the workspace — the workspace is the only boundary, so there is only one address.
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
