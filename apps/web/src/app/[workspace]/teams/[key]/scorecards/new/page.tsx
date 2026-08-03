import { ScorecardCreateView } from '@/widgets/scorecard-create'

import { loadTeamScope } from '../../../../team-scope'

export const dynamic = 'force-dynamic'

// Run an evaluation AS this team — `/{workspace}/teams/ENG/scorecards/new`. The path is what carries the owner:
// submitted from the workspace address the control plane has to infer whose batch it is, and the inference is
// what made every team's page show the same one team's work.
export default async function NewTeamScorecardPage({
  params,
}: {
  params: Promise<{ workspace: string; key: string }>
}) {
  const { workspace, key } = await params
  const team = await loadTeamScope({ workspace, slug: key, section: 'scorecards', create: true })
  return <ScorecardCreateView workspace={workspace} team={team} />
}
