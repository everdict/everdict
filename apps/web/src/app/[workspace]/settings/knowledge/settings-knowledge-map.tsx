'use client'

import { useEffect } from 'react'

import { useInfraPanelOptional } from '@/widgets/infra-panel'
import { KnowledgeExplorer } from '@/features/knowledge-graph'
import type { KnowledgeGraph } from '@/entities/knowledge'

// Settings › Knowledge — the map is the whole screen; the node detail belongs to the right-hand split-view panel
// (the surface runtimes, files and the agent chat already use). This is the seam between the two: it publishes the
// map the panel reads and routes selection both ways, so picking a node here opens it there, and picking a
// neighbour there re-centres it here. Optional context: a framed render (no provider) is a transient bounced
// state — degrade to a map with no detail pane rather than crashing before the bounce guard escapes the document.
export function SettingsKnowledgeMap({
  graph,
  canReindex,
}: {
  graph: KnowledgeGraph
  canReindex: boolean
}) {
  const infra = useInfraPanelOptional()
  const publish = infra?.publishKnowledgeGraph
  useEffect(() => {
    publish?.(graph)
  }, [graph, publish])

  return (
    <KnowledgeExplorer
      graph={graph}
      canReindex={canReindex}
      selectedId={infra?.knowledgeNodeId ?? null}
      onSelect={(nodeId) => infra?.openKnowledgeNode(nodeId)}
    />
  )
}
