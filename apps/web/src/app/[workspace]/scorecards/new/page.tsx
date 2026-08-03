import { ScorecardCreateView } from '@/widgets/scorecard-create'

export const dynamic = 'force-dynamic'

// The workspace-wide entry: nothing is pinned, so the batch inherits the team that owns the harness chosen.
export default async function NewScorecardPage({
  params,
}: {
  params: Promise<{ workspace: string }>
}) {
  const { workspace } = await params
  return <ScorecardCreateView workspace={workspace} />
}
