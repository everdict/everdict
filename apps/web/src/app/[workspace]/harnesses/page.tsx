import { HarnessListView } from '@/widgets/harness-list'

export const dynamic = 'force-dynamic'

// The workspace's harness list — the only address. Narrowing by owning team is a FILTER on this list, so a `?team=` link from the days when the
// team axis was a path still opens: a query parameter of the same name is now that filter's spelling.
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
