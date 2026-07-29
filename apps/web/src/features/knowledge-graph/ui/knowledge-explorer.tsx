'use client'

import { useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Maximize2, Network, RefreshCw, Search, ZoomIn, ZoomOut } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import type { KnowledgeGraph } from '@/entities/knowledge'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { EmptyState } from '@/shared/ui/empty-state'
import { Input } from '@/shared/ui/input'

import { reindexKnowledgeAction } from '../api/reindex-knowledge'
import { humanize, nodeColor } from '../lib/node-style'
import { KnowledgeGraphCanvas, type GraphCanvasHandle } from './knowledge-graph-canvas'

// Settings › Knowledge — the workspace's knowledge as a MAP: claims and skills over the entities they concern, drawn
// as an interactive force graph. The screen is the map alone; the node detail lives elsewhere (the caller routes the
// selection to the split-view panel), so this component stays a pure map: draw, filter, search, pick.
//
// The simulation is O(n²) per frame, so above this cap we lay out the best-attested nodes and say how many are left.
const MAX_RENDER_NODES = 260

export function KnowledgeExplorer({
  graph,
  canReindex,
  selectedId,
  onSelect,
}: {
  graph: KnowledgeGraph
  canReindex: boolean
  // The picked node, owned by the caller (the panel and the map show the same selection).
  selectedId: string | null
  onSelect: (nodeId: string | null) => void
}) {
  const t = useTranslations('knowledge')
  const router = useRouter()
  const canvas = useRef<GraphCanvasHandle>(null)
  const [query, setQuery] = useState('')
  const [hiddenTypes, setHiddenTypes] = useState<ReadonlySet<string>>(new Set())
  const [pending, startTransition] = useTransition()

  const typeCounts = useMemo(
    () => Object.entries(graph.stats.nodesByType).sort((a, b) => b[1] - a[1]),
    [graph.stats.nodesByType]
  )

  const { renderNodes, truncated } = useMemo(() => {
    const visible = graph.nodes.filter((n) => !hiddenTypes.has(n.type))
    if (visible.length <= MAX_RENDER_NODES) return { renderNodes: visible, truncated: 0 }
    const kept = [...visible]
      .sort((a, b) => b.evidenceCount - a.evidenceCount)
      .slice(0, MAX_RENDER_NODES)
    return { renderNodes: kept, truncated: visible.length - kept.length }
  }, [graph.nodes, hiddenTypes])

  // Edges only exist on the map when BOTH endpoints do — a type the member filtered out takes its edges with it, and
  // the workspace hub's scoping star never had a node to attach to.
  const renderEdges = useMemo(() => {
    const present = new Set(renderNodes.map((n) => n.nodeId))
    return graph.edges.filter(
      (e) =>
        e.subjectNodeId !== undefined &&
        e.objectNodeId !== undefined &&
        present.has(e.subjectNodeId) &&
        present.has(e.objectNodeId)
    )
  }, [graph.edges, renderNodes])

  // Search narrows by label or type; everything else fades out on the map instead of disappearing (the shape of the
  // graph is the context that makes a hit meaningful).
  const matchedIds = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle === '') return null
    return new Set(
      renderNodes
        .filter(
          (n) =>
            n.label.toLowerCase().includes(needle) ||
            n.type.includes(needle) ||
            n.key.toLowerCase().includes(needle)
        )
        .map((n) => n.nodeId)
    )
  }, [query, renderNodes])

  // Follow the caller's selection: a neighbour picked in the detail panel (or a search hit) is centred here.
  useEffect(() => {
    if (selectedId !== null) canvas.current?.focusNode(selectedId)
  }, [selectedId])

  const submitSearch = (): void => {
    const first =
      matchedIds === null ? undefined : renderNodes.find((n) => matchedIds.has(n.nodeId))
    if (first) onSelect(first.nodeId)
  }

  const reindex = (): void =>
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
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[12rem] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitSearch()
            }}
            placeholder={t('searchPlaceholder')}
            className="h-8 pl-8 text-[13px]"
            aria-label={t('searchPlaceholder')}
          />
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t('zoomOut')}
            onClick={() => canvas.current?.zoomBy(1 / 1.3)}
          >
            <ZoomOut />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t('zoomIn')}
            onClick={() => canvas.current?.zoomBy(1.3)}
          >
            <ZoomIn />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t('fit')}
            onClick={() => canvas.current?.fit()}
          >
            <Maximize2 />
          </Button>
        </div>
        {reindexButton}
      </div>

      {/* The legend doubles as the type filter — click a type to drop it from the map. */}
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        {typeCounts.map(([type, count]) => {
          const hidden = hiddenTypes.has(type)
          return (
            <button
              key={type}
              type="button"
              aria-pressed={!hidden}
              onClick={() =>
                setHiddenTypes((prev) => {
                  const next = new Set(prev)
                  if (!next.delete(type)) next.add(type)
                  return next
                })
              }
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[12px] text-muted-foreground transition-opacity hover:bg-accent',
                hidden && 'opacity-40'
              )}
            >
              <span
                className="size-2.5 rounded-full"
                style={{ backgroundColor: nodeColor(type) }}
                aria-hidden
              />
              {humanize(type)}
              <span className="tabular-nums text-muted-foreground/70">{count}</span>
            </button>
          )
        })}
      </div>

      <div className="h-[clamp(26rem,calc(100dvh-21rem),48rem)] overflow-hidden rounded-xl border border-border bg-card/40">
        <KnowledgeGraphCanvas
          nodes={renderNodes}
          edges={renderEdges}
          selectedId={selectedId}
          matchedIds={matchedIds}
          onSelect={onSelect}
          handleRef={canvas}
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-muted-foreground">
        <span>
          {/* What is on the map right now — not the whole-graph totals, which would keep counting a type the
              member just filtered out. */}
          {t('summary', { nodes: renderNodes.length, edges: renderEdges.length })}
          {truncated > 0 && (
            <span className="ml-2 text-muted-foreground/70">
              {t('truncated', { count: truncated })}
            </span>
          )}
        </span>
        <span className="text-muted-foreground/70">{t('canvasHint')}</span>
      </div>
    </div>
  )
}
