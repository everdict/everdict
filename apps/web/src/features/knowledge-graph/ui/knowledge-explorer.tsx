'use client'

import { Network, RefreshCw } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { useMemo, useState, useTransition } from 'react'
import { toast } from 'sonner'

import type { KnowledgeGraph, KnowledgeNodeView } from '@/entities/knowledge'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/card'
import { EmptyState } from '@/shared/ui/empty-state'
import { reindexKnowledgeAction } from '../api/reindex-knowledge'
import { humanize, nodeColor, predicateRank } from '../lib/node-style'
import { KnowledgeGraphCanvas } from './knowledge-graph-canvas'

// Force layout is O(n²); above this we render the highest-evidence nodes and note the rest.
const MAX_RENDER_NODES = 220

export function KnowledgeExplorer({ graph, canReindex }: { graph: KnowledgeGraph; canReindex: boolean }) {
  const t = useTranslations('knowledge')
  const router = useRouter()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const nodeById = useMemo(() => new Map(graph.nodes.map((n) => [n.nodeId, n])), [graph.nodes])

  const { renderNodes, truncated } = useMemo(() => {
    if (graph.nodes.length <= MAX_RENDER_NODES) return { renderNodes: graph.nodes, truncated: 0 }
    const kept = [...graph.nodes].sort((a, b) => b.evidenceCount - a.evidenceCount).slice(0, MAX_RENDER_NODES)
    return { renderNodes: kept, truncated: graph.nodes.length - kept.length }
  }, [graph.nodes])

  const typeCounts = useMemo(
    () => Object.entries(graph.stats.nodesByType).sort((a, b) => b[1] - a[1]),
    [graph.stats.nodesByType],
  )

  const selected = selectedId ? (nodeById.get(selectedId) ?? null) : null

  const reindex = () =>
    startTransition(async () => {
      const r = await reindexKnowledgeAction()
      if (r.ok) {
        toast.success(t('reindexed', { nodes: r.nodes ?? 0, edges: r.edges ?? 0 }))
        router.refresh()
      } else {
        toast.error(r.error ?? t('reindexError'))
      }
    })

  const reindexButton = canReindex ? (
    <Button size="sm" variant="secondary" onClick={reindex} disabled={pending}>
      <RefreshCw className={pending ? 'animate-spin' : ''} />
      {t('reindex')}
    </Button>
  ) : null

  if (graph.nodes.length === 0) {
    return (
      <EmptyState
        icon={<Network />}
        title={t('emptyTitle')}
        hint={canReindex ? t('emptyHint') : t('emptyHintReadonly')}
        action={reindexButton ?? undefined}
      />
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-[13px] text-muted-foreground">
          {t('summary', { nodes: graph.stats.totalNodes, edges: graph.stats.totalEdges })}
          {truncated > 0 && (
            <span className="ml-2 text-muted-foreground/70">{t('truncated', { count: truncated })}</span>
          )}
        </div>
        {reindexButton}
      </div>

      {/* Node-type legend */}
      <div className="flex flex-wrap gap-x-3 gap-y-1.5">
        {typeCounts.map(([type, count]) => (
          <span key={type} className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <span className="size-2.5 rounded-full" style={{ backgroundColor: nodeColor(type) }} />
            {humanize(type)} <span className="tabular-nums text-muted-foreground/70">{count}</span>
          </span>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_18rem]">
        <Card className="overflow-hidden bg-card/40">
          <KnowledgeGraphCanvas
            nodes={renderNodes}
            edges={graph.edges}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        </Card>
        <NodeDetail selected={selected} graph={graph} nodeById={nodeById} onSelect={setSelectedId} />
      </div>
    </div>
  )
}

function NodeDetail({
  selected,
  graph,
  nodeById,
  onSelect,
}: {
  selected: KnowledgeNodeView | null
  graph: KnowledgeGraph
  nodeById: Map<string, KnowledgeNodeView>
  onSelect: (id: string | null) => void
}) {
  const t = useTranslations('knowledge')

  const facts = useMemo(() => {
    if (!selected) return []
    return graph.edges
      .flatMap((e) => {
        if (e.subjectNodeId === undefined || e.objectNodeId === undefined) return []
        const isSubject = e.subjectNodeId === selected.nodeId
        const isObject = e.objectNodeId === selected.nodeId
        if (!isSubject && !isObject) return []
        const otherId = isSubject ? e.objectNodeId : e.subjectNodeId
        const other = nodeById.get(otherId)
        // Only meaningful, materialised endpoints — drops the scoping edge to the (unmaterialised) workspace hub.
        if (other === undefined) return []
        return [{ predicate: e.predicate, direction: isSubject ? 'out' : ('in' as const), otherId, other }]
      })
      .sort((a, b) => predicateRank(a.predicate) - predicateRank(b.predicate))
  }, [selected, graph.edges, nodeById])

  if (!selected) {
    return (
      <Card className="grid place-items-center p-6 text-center text-[12px] text-muted-foreground">
        {t('selectHint')}
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <span className="size-2.5 rounded-full" style={{ backgroundColor: nodeColor(selected.type) }} />
          <Badge tone="outline">{humanize(selected.type)}</Badge>
          {selected.version && <span className="text-[11px] text-muted-foreground">@{selected.version}</span>}
          {selected.resolution === 'dangling' && <Badge tone="warning">{t('dangling')}</Badge>}
        </div>
        <CardTitle className="mt-1 break-words text-[14px]">{selected.label}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="text-[11px] text-muted-foreground">{t('evidence', { count: selected.evidenceCount })}</div>
        <div>
          <div className="mb-1.5 text-[11px] font-[560] uppercase tracking-wide text-muted-foreground/80">
            {t('relationships')}
          </div>
          {facts.length === 0 ? (
            <p className="text-[12px] text-muted-foreground">{t('noRelationships')}</p>
          ) : (
            <ul className="space-y-1">
              {facts.map((f) => (
                <li key={`${f.direction}:${f.predicate}:${f.otherId}`} className="flex items-baseline gap-1.5 text-[12px]">
                  <span className="text-muted-foreground/60">{f.direction === 'out' ? '→' : '←'}</span>
                  <span className="shrink-0 text-muted-foreground">{humanize(f.predicate)}</span>
                  <button
                    type="button"
                    className="truncate text-left text-foreground hover:underline"
                    onClick={() => onSelect(f.otherId)}
                  >
                    {f.other.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
