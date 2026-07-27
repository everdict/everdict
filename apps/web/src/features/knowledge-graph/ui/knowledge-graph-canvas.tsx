'use client'

import { useMemo, useState } from 'react'

import type { KnowledgeEdgeView, KnowledgeNodeView } from '@/entities/knowledge'
import { forceLayout, type Point } from '../lib/layout'
import { nodeColor } from '../lib/node-style'

const VIEW_W = 1000
const VIEW_H = 640

// A dot's radius grows (gently) with how much evidence backs the node — hubs read larger.
function radiusFor(evidenceCount: number): number {
  return 5 + Math.min(9, Math.sqrt(Math.max(0, evidenceCount)))
}

// The interactive SVG force-graph. Presentational: it lays out whatever nodes/edges it is given (the parent caps the
// count) and reports selection up. Edges to a node outside the given set (e.g. the non-materialised workspace hub) are
// dropped so the diagram shows the MEANINGFUL inter-entity relationships, not the scoping star.
export function KnowledgeGraphCanvas({
  nodes,
  edges,
  selectedId,
  onSelect,
}: {
  nodes: KnowledgeNodeView[]
  edges: KnowledgeEdgeView[]
  selectedId: string | null
  onSelect: (id: string | null) => void
}) {
  const [hoveredId, setHoveredId] = useState<string | null>(null)

  const nodeIds = useMemo(() => nodes.map((n) => n.nodeId), [nodes])
  const renderEdges = useMemo(() => {
    const present = new Set(nodeIds)
    return edges.filter(
      (e) =>
        e.subjectNodeId !== undefined &&
        e.objectNodeId !== undefined &&
        present.has(e.subjectNodeId) &&
        present.has(e.objectNodeId),
    )
  }, [edges, nodeIds])

  // Layout only recomputes when the graph's SHAPE changes (memoized inputs), not on hover/select.
  const positions = useMemo(
    () =>
      forceLayout(
        nodeIds,
        renderEdges.map((e) => ({ source: e.subjectNodeId as string, target: e.objectNodeId as string })),
        { width: VIEW_W, height: VIEW_H },
      ),
    [nodeIds, renderEdges],
  )

  const degree = useMemo(() => {
    const d = new Map<string, number>()
    for (const e of renderEdges) {
      d.set(e.subjectNodeId as string, (d.get(e.subjectNodeId as string) ?? 0) + 1)
      d.set(e.objectNodeId as string, (d.get(e.objectNodeId as string) ?? 0) + 1)
    }
    return d
  }, [renderEdges])

  // When nothing is focused, label the highest-degree hubs so the diagram is legible at rest.
  const hubLabels = useMemo(() => {
    const ranked = [...nodeIds].sort((a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0))
    return new Set(ranked.slice(0, 12))
  }, [nodeIds, degree])

  const focusId = hoveredId ?? selectedId
  const neighbors = useMemo(() => {
    if (focusId === null) return new Set<string>()
    const s = new Set<string>()
    for (const e of renderEdges) {
      if (e.subjectNodeId === focusId) s.add(e.objectNodeId as string)
      else if (e.objectNodeId === focusId) s.add(e.subjectNodeId as string)
    }
    return s
  }, [focusId, renderEdges])

  const pos = (id: string): Point => positions.get(id) ?? { x: VIEW_W / 2, y: VIEW_H / 2 }

  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      preserveAspectRatio="xMidYMid meet"
      className="h-[520px] w-full touch-none select-none text-muted-foreground"
      role="img"
      aria-label="Workspace knowledge graph"
      onClick={() => onSelect(null)}
    >
      {/* Edges */}
      <g strokeLinecap="round">
        {renderEdges.map((e) => {
          const a = pos(e.subjectNodeId as string)
          const b = pos(e.objectNodeId as string)
          const touchesFocus =
            focusId !== null && (e.subjectNodeId === focusId || e.objectNodeId === focusId)
          const dim = focusId !== null && !touchesFocus
          return (
            <line
              key={e.id}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke="currentColor"
              strokeWidth={touchesFocus ? 1.6 : 1}
              strokeOpacity={dim ? 0.05 : touchesFocus ? 0.5 : 0.16}
              strokeDasharray={e.polarity === 'negated' ? '4 3' : undefined}
            />
          )
        })}
      </g>

      {/* Nodes */}
      <g>
        {nodes.map((n) => {
          const p = pos(n.nodeId)
          const isFocus = n.nodeId === focusId
          const isNeighbor = neighbors.has(n.nodeId)
          const dim = focusId !== null && !isFocus && !isNeighbor
          const r = radiusFor(n.evidenceCount)
          const showLabel = isFocus || isNeighbor || (focusId === null && hubLabels.has(n.nodeId))
          return (
            <g
              key={n.nodeId}
              transform={`translate(${p.x},${p.y})`}
              className="cursor-pointer"
              opacity={dim ? 0.3 : 1}
              onMouseEnter={() => setHoveredId(n.nodeId)}
              onMouseLeave={() => setHoveredId(null)}
              onClick={(ev) => {
                ev.stopPropagation()
                onSelect(n.nodeId === selectedId ? null : n.nodeId)
              }}
            >
              {n.nodeId === selectedId && (
                <circle r={r + 4} fill="none" stroke={nodeColor(n.type)} strokeWidth={2} strokeOpacity={0.9} />
              )}
              <circle
                r={r}
                fill={nodeColor(n.type)}
                stroke="var(--color-background, #fff)"
                strokeWidth={1.5}
                fillOpacity={0.92}
              >
                <title>
                  {n.label} · {n.type}
                  {n.version ? `@${n.version}` : ''}
                </title>
              </circle>
              {showLabel && (
                <text
                  x={r + 4}
                  y={4}
                  fontSize={12}
                  className="fill-foreground"
                  style={{ paintOrder: 'stroke', stroke: 'var(--color-background, #fff)', strokeWidth: 3 }}
                >
                  {n.label.length > 28 ? `${n.label.slice(0, 27)}…` : n.label}
                </text>
              )}
            </g>
          )
        })}
      </g>
    </svg>
  )
}
