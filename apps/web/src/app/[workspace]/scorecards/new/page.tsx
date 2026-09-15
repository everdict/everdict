import { ScorecardCreateView } from '@/widgets/scorecard-create'

export const dynamic = 'force-dynamic'

// The one entry for starting a batch evaluation in the workspace.
export default async function NewScorecardPage({
  params,
}: {
  params: Promise<{ workspace: string }>
}) {
  const { workspace } = await params
  return <ScorecardCreateView workspace={workspace} />
}
