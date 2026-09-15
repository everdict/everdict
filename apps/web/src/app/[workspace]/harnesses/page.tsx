import { HarnessListView } from '@/widgets/harness-list'

export const dynamic = 'force-dynamic'

// The workspace's harness list — the only address.
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
