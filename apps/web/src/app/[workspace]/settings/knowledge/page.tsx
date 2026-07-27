import { getTranslations } from 'next-intl/server'

import { type KnowledgeGraph, knowledgeGraphSchema } from '@/entities/knowledge'
import { KnowledgeExplorer } from '@/features/knowledge-graph'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// Workspace › Knowledge — the workspace's eval data (scorecards, runs, harnesses, datasets, judges, runtimes, members,
// …) projected into a queryable graph of nodes + typed edges, rendered as an interactive map. Read = scorecards:read
// (the graph is derived from eval data); rebuild (reindex) = settings:write. See docs/architecture/knowledge-graph.md.
export default async function KnowledgeSettingsPage() {
  const t = await getTranslations('settingsNav')
  const s = await getTranslations('settingsPage')
  const k = await getTranslations('knowledge')
  const { principal, ctx } = await currentPrincipal()
  const canRead = can(principal?.roles, 'scorecards:read')
  const canReindex = can(principal?.roles, 'settings:write')

  const header = <PageHeader title={t('knowledge')} description={t('knowledgeDesc')} />
  if (!canRead) {
    return (
      <div className="space-y-6">
        {header}
        <EmptyState title={s('noPermissionTitle')} hint={s('noPermissionHint')} />
      </div>
    )
  }

  // The whole-workspace graph (rooted server-side at the workspace hub node). An unconfigured knowledge service (no DB)
  // 404s → treat as an empty graph so the page still renders with the reindex prompt.
  let graph: KnowledgeGraph = { root: '', nodes: [], edges: [], stats: { totalNodes: 0, totalEdges: 0, nodesByType: {}, edgesByPredicate: {} } }
  let unavailable = false
  try {
    graph = knowledgeGraphSchema.parse(await controlPlane.knowledgeGraph(ctx))
  } catch {
    unavailable = true
  }

  return (
    <div className="space-y-6">
      {header}
      {unavailable ? (
        <EmptyState title={k('unavailableTitle')} hint={k('unavailableHint')} />
      ) : (
        <KnowledgeExplorer graph={graph} canReindex={canReindex} />
      )}
    </div>
  )
}
