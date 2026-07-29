'use client'

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react'

import type { KnowledgeEdgeView, KnowledgeNodeView } from '@/entities/knowledge'

import {
  ALPHA_MIN,
  createSimulation,
  reheat,
  tickSimulation,
  type Simulation,
} from '../lib/graph-simulation'
import { nodeColor } from '../lib/node-style'

// The map surface — a canvas-2D force graph you can pan, zoom, drag and pick, drawn from a live simulation. Canvas
// (not SVG) because the picture repaints every frame while the graph settles and while the pointer moves.
//
// Presentational: it draws whatever nodes/edges it is handed (the parent caps the count and applies filters) and
// reports selection up. An edge whose endpoint is not in the given node set is dropped — the workspace hub's scoping
// star would otherwise drown the actual relationships.

export interface GraphCanvasHandle {
  // Frame the whole graph (the toolbar's fit button, and the automatic framing while the first layout settles).
  fit: () => void
  zoomBy: (factor: number) => void
  // Centre on one node without changing zoom — how a search hit or a panel-side neighbour jump lands.
  focusNode: (id: string) => void
}

const MIN_SCALE = 0.15
const MAX_SCALE = 4
const LABEL_SCALE = 0.85 // below this, only focused/hub labels are drawn — zoom in to read the rest
const HUB_LABELS = 14 // how many of the best-connected nodes stay labelled at rest
const CLICK_SLOP = 4 // px of pointer travel still counted as a click, not a drag

interface View {
  scale: number
  tx: number
  ty: number
}

interface Palette {
  foreground: string
  muted: string
  background: string
  border: string
}

function radiusFor(degree: number): number {
  return 3.6 + Math.min(9.5, Math.sqrt(degree) * 2.3)
}

function readPalette(): Palette {
  const style = getComputedStyle(document.documentElement)
  const read = (name: string, fallback: string): string =>
    style.getPropertyValue(name).trim() || fallback
  return {
    foreground: read('--foreground', '#0d0e10'),
    muted: read('--muted-foreground', '#6b7280'),
    background: read('--background', '#ffffff'),
    border: read('--border-strong', 'rgba(13,14,16,0.14)'),
  }
}

export function KnowledgeGraphCanvas({
  nodes,
  edges,
  selectedId,
  matchedIds,
  onSelect,
  handleRef,
}: {
  nodes: KnowledgeNodeView[]
  edges: KnowledgeEdgeView[]
  selectedId: string | null
  // Search hits — when non-null everything else is dimmed away. null = no active search.
  matchedIds: Set<string> | null
  onSelect: (id: string | null) => void
  handleRef?: RefObject<GraphCanvasHandle | null>
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewRef = useRef<View>({ scale: 1, tx: 0, ty: 0 })
  const paletteRef = useRef<Palette | null>(null)
  const hoveredRef = useRef<string | null>(null)
  const selectedRef = useRef<string | null>(selectedId)
  const matchedRef = useRef<Set<string> | null>(matchedIds)
  const frameRef = useRef<number | null>(null)
  // Auto-framing stays on until the member takes control of the viewport (pan / zoom / drag).
  const autoFitRef = useRef(true)

  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.nodeId, n])), [nodes])

  // Only edges whose BOTH endpoints are on the map participate — in layout and in the drawing.
  const renderEdges = useMemo(
    () =>
      edges.filter(
        (e) =>
          e.subjectNodeId !== undefined &&
          e.objectNodeId !== undefined &&
          nodeById.has(e.subjectNodeId) &&
          nodeById.has(e.objectNodeId)
      ),
    [edges, nodeById]
  )

  const neighborsById = useMemo(() => {
    const map = new Map<string, Set<string>>()
    for (const e of renderEdges) {
      const a = e.subjectNodeId as string
      const b = e.objectNodeId as string
      if (!map.has(a)) map.set(a, new Set())
      if (!map.has(b)) map.set(b, new Set())
      map.get(a)?.add(b)
      map.get(b)?.add(a)
    }
    return map
  }, [renderEdges])

  // The simulation is rebuilt only when the graph's SHAPE changes — never on hover, selection or search.
  const sim = useMemo<Simulation>(
    () =>
      createSimulation(
        nodes.map((n) => n.nodeId),
        renderEdges.map((e) => ({
          source: e.subjectNodeId as string,
          target: e.objectNodeId as string,
        }))
      ),
    [nodes, renderEdges]
  )

  const hubLabels = useMemo(() => {
    const ranked = [...sim.nodes].sort((a, b) => b.degree - a.degree)
    return new Set(ranked.slice(0, HUB_LABELS).map((n) => n.id))
  }, [sim])

  selectedRef.current = selectedId
  matchedRef.current = matchedIds

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const palette = paletteRef.current ?? readPalette()
    const width = container.clientWidth
    const height = container.clientHeight
    const view = viewRef.current
    const focusId = hoveredRef.current ?? selectedRef.current
    const focusNeighbors =
      focusId !== null ? (neighborsById.get(focusId) ?? new Set<string>()) : null
    const matched = matchedRef.current

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    const dpr = window.devicePixelRatio || 1
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.translate(width / 2 + view.tx, height / 2 + view.ty)
    ctx.scale(view.scale, view.scale)

    // How present a node is. An active search takes over the map — hits stay lit, everything else fades, so the
    // answer is never dimmed by a leftover selection. Otherwise, focusing a node fades everything unrelated to it.
    const presence = (id: string): number => {
      if (matched !== null) return matched.has(id) ? 1 : 0.1
      if (focusId === null) return 1
      if (id === focusId || focusNeighbors?.has(id)) return 1
      return 0.16
    }

    ctx.lineCap = 'round'
    for (const e of renderEdges) {
      const a = sim.nodes[sim.index.get(e.subjectNodeId as string) ?? -1]
      const b = sim.nodes[sim.index.get(e.objectNodeId as string) ?? -1]
      if (!a || !b) continue
      const touchesFocus = focusId !== null && (a.id === focusId || b.id === focusId)
      const alpha = Math.min(presence(a.id), presence(b.id)) * (touchesFocus ? 0.8 : 0.38)
      if (alpha < 0.03) continue
      ctx.globalAlpha = alpha
      ctx.strokeStyle = touchesFocus ? palette.foreground : palette.muted
      ctx.lineWidth = (touchesFocus ? 1.5 : 1) / view.scale
      ctx.setLineDash(e.polarity === 'negated' ? [5 / view.scale, 4 / view.scale] : [])
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.stroke()
    }
    ctx.setLineDash([])

    const labels: { x: number; y: number; text: string; alpha: number }[] = []
    for (const node of sim.nodes) {
      const meta = nodeById.get(node.id)
      if (!meta) continue
      const alpha = presence(node.id)
      if (alpha < 0.03) continue
      const r = radiusFor(node.degree)
      const color = nodeColor(meta.type)
      const isFocus = node.id === focusId
      const isSelected = node.id === selectedRef.current

      ctx.globalAlpha = alpha
      if (isSelected) {
        ctx.beginPath()
        ctx.arc(node.x, node.y, r + 4.5 / view.scale, 0, Math.PI * 2)
        ctx.strokeStyle = color
        ctx.lineWidth = 2 / view.scale
        ctx.stroke()
      }
      ctx.beginPath()
      ctx.arc(node.x, node.y, r, 0, Math.PI * 2)
      // A pending reference (an entity a claim points at that nothing has projected yet) draws hollow — present on
      // the map, visibly not yet a materialised entity.
      if (meta.resolution === 'dangling') {
        ctx.fillStyle = palette.background
        ctx.fill()
        ctx.strokeStyle = color
        ctx.lineWidth = 1.6 / view.scale
        ctx.stroke()
      } else {
        ctx.fillStyle = color
        ctx.fill()
        ctx.strokeStyle = palette.background
        ctx.lineWidth = 1.5 / view.scale
        ctx.stroke()
      }

      const labelled =
        isFocus ||
        isSelected ||
        (matched !== null && matched.has(node.id)) ||
        focusNeighbors?.has(node.id) === true ||
        view.scale >= LABEL_SCALE ||
        hubLabels.has(node.id)
      if (labelled) {
        const text = meta.label.length > 34 ? `${meta.label.slice(0, 33)}…` : meta.label
        labels.push({ x: node.x, y: node.y + r + 11 / view.scale, text, alpha })
      }
    }

    // Labels last so no node covers them.
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = `${12 / view.scale}px ui-sans-serif, system-ui, sans-serif`
    ctx.lineJoin = 'round'
    for (const label of labels) {
      ctx.globalAlpha = label.alpha
      ctx.strokeStyle = palette.background
      ctx.lineWidth = 3.5 / view.scale
      ctx.strokeText(label.text, label.x, label.y)
      ctx.fillStyle = palette.foreground
      ctx.fillText(label.text, label.x, label.y)
    }
    ctx.globalAlpha = 1
  }, [sim, renderEdges, nodeById, neighborsById, hubLabels])

  const fit = useCallback(() => {
    const container = containerRef.current
    if (!container || sim.nodes.length === 0) return
    let minX = Number.POSITIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    let maxY = Number.NEGATIVE_INFINITY
    for (const n of sim.nodes) {
      minX = Math.min(minX, n.x)
      minY = Math.min(minY, n.y)
      maxX = Math.max(maxX, n.x)
      maxY = Math.max(maxY, n.y)
    }
    const pad = 64
    const w = Math.max(maxX - minX, 1)
    const h = Math.max(maxY - minY, 1)
    const scale = Math.min(
      MAX_SCALE,
      Math.max(
        MIN_SCALE,
        Math.min((container.clientWidth - pad) / w, (container.clientHeight - pad) / h, 1.6)
      )
    )
    viewRef.current = {
      scale,
      tx: -((minX + maxX) / 2) * scale,
      ty: -((minY + maxY) / 2) * scale,
    }
  }, [sim])

  // The animation loop: tick while the simulation is warm, then rest. A redraw request (hover, selection, resize)
  // wakes it for a single frame.
  const running = useRef(false)
  const loop = useCallback(() => {
    running.current = true
    const step = (): void => {
      const moving = tickSimulation(sim)
      if (moving && autoFitRef.current) fit()
      draw()
      if (moving || sim.alpha > ALPHA_MIN) {
        frameRef.current = requestAnimationFrame(step)
      } else {
        running.current = false
        frameRef.current = null
      }
    }
    if (frameRef.current === null) frameRef.current = requestAnimationFrame(step)
  }, [sim, draw, fit])

  const requestDraw = useCallback(() => {
    if (running.current) return
    requestAnimationFrame(draw)
  }, [draw])

  // Size the backing store to the container (device-pixel aware) and repaint on any layout change — the split-view
  // panel opening halves this surface's width.
  useEffect(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas) return
    const resize = (): void => {
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.max(1, Math.round(container.clientWidth * dpr))
      canvas.height = Math.max(1, Math.round(container.clientHeight * dpr))
      canvas.style.width = `${container.clientWidth}px`
      canvas.style.height = `${container.clientHeight}px`
      if (autoFitRef.current) fit()
      requestDraw()
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(container)
    return () => observer.disconnect()
  }, [fit, requestDraw])

  // The theme is the parent document's to decide — mirror it into the canvas palette when it flips.
  useEffect(() => {
    paletteRef.current = readPalette()
    requestDraw()
    const observer = new MutationObserver(() => {
      paletteRef.current = readPalette()
      requestDraw()
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [requestDraw])

  // A new graph shape starts a fresh settle.
  useEffect(() => {
    autoFitRef.current = true
    reheat(sim, 1)
    loop()
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
      frameRef.current = null
      running.current = false
    }
  }, [sim, loop])

  useEffect(() => {
    requestDraw()
  }, [selectedId, matchedIds, requestDraw])

  const toWorld = useCallback((clientX: number, clientY: number): { x: number; y: number } => {
    const container = containerRef.current
    if (!container) return { x: 0, y: 0 }
    const rect = container.getBoundingClientRect()
    const view = viewRef.current
    return {
      x: (clientX - rect.left - rect.width / 2 - view.tx) / view.scale,
      y: (clientY - rect.top - rect.height / 2 - view.ty) / view.scale,
    }
  }, [])

  const nodeAt = useCallback(
    (clientX: number, clientY: number): string | null => {
      const { x, y } = toWorld(clientX, clientY)
      const matched = matchedRef.current
      let best: string | null = null
      let bestDistance = Number.POSITIVE_INFINITY
      for (const node of sim.nodes) {
        if (matched !== null && !matched.has(node.id)) continue
        const r = radiusFor(node.degree) + 6 / viewRef.current.scale
        const d = Math.hypot(node.x - x, node.y - y)
        if (d <= r && d < bestDistance) {
          best = node.id
          bestDistance = d
        }
      }
      return best
    },
    [sim, toWorld]
  )

  useImperativeHandle(
    handleRef,
    () => ({
      fit: () => {
        autoFitRef.current = false
        fit()
        requestDraw()
      },
      zoomBy: (factor: number) => {
        autoFitRef.current = false
        const view = viewRef.current
        viewRef.current = {
          ...view,
          scale: Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor)),
        }
        requestDraw()
      },
      focusNode: (id: string) => {
        const node = sim.nodes[sim.index.get(id) ?? -1]
        if (!node) return
        autoFitRef.current = false
        const view = viewRef.current
        viewRef.current = { ...view, tx: -node.x * view.scale, ty: -node.y * view.scale }
        requestDraw()
      },
    }),
    [fit, requestDraw, sim]
  )

  // --- pointer interaction: drag a node, pan the field, pick a node ---
  const dragRef = useRef<{
    pointerId: number
    nodeIndex: number | null
    startX: number
    startY: number
    originTx: number
    originTy: number
    moved: boolean
  } | null>(null)

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    const id = nodeAt(e.clientX, e.clientY)
    const index = id !== null ? (sim.index.get(id) ?? null) : null
    if (index !== null) {
      sim.nodes[index].pinned = true
      reheat(sim, 0.32)
      loop()
    }
    dragRef.current = {
      pointerId: e.pointerId,
      nodeIndex: index,
      startX: e.clientX,
      startY: e.clientY,
      originTx: viewRef.current.tx,
      originTy: viewRef.current.ty,
      moved: false,
    }
    // Capture keeps a drag alive past the canvas edge; it is an enhancement, so a browser that refuses it (or a
    // pointer that is already gone) must not abort the gesture.
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // no capture — the drag still tracks while the pointer stays over the canvas
    }
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    const drag = dragRef.current
    if (drag === null) {
      const id = nodeAt(e.clientX, e.clientY)
      if (id !== hoveredRef.current) {
        hoveredRef.current = id
        requestDraw()
      }
      return
    }
    const dx = e.clientX - drag.startX
    const dy = e.clientY - drag.startY
    if (!drag.moved && Math.hypot(dx, dy) > CLICK_SLOP) drag.moved = true
    if (!drag.moved) return
    autoFitRef.current = false
    if (drag.nodeIndex !== null) {
      const { x, y } = toWorld(e.clientX, e.clientY)
      const node = sim.nodes[drag.nodeIndex]
      node.x = x
      node.y = y
      reheat(sim, 0.3)
      loop()
    } else {
      viewRef.current = {
        ...viewRef.current,
        tx: drag.originTx + dx,
        ty: drag.originTy + dy,
      }
      requestDraw()
    }
  }

  const endDrag = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    const drag = dragRef.current
    dragRef.current = null
    if (drag === null) return
    if (drag.nodeIndex !== null) {
      sim.nodes[drag.nodeIndex].pinned = false
      reheat(sim, 0.2)
      loop()
    }
    if (e.currentTarget.hasPointerCapture(drag.pointerId))
      e.currentTarget.releasePointerCapture(drag.pointerId)
    if (drag.moved) return
    // A tap, not a drag — pick the node under it (or clear the selection on empty space).
    const id = drag.nodeIndex !== null ? sim.nodes[drag.nodeIndex].id : null
    onSelect(id !== null && id === selectedRef.current ? null : id)
  }

  // Wheel zoom is bound imperatively: React's synthetic wheel listener is passive, so it could not stop the page
  // from scrolling underneath the zoom.
  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      autoFitRef.current = false
      const rect = container.getBoundingClientRect()
      const view = viewRef.current
      const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015))
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor))
      // Keep the point under the cursor fixed while zooming.
      const px = e.clientX - rect.left - rect.width / 2
      const py = e.clientY - rect.top - rect.height / 2
      const k = scale / view.scale
      viewRef.current = { scale, tx: px - (px - view.tx) * k, ty: py - (py - view.ty) * k }
      requestDraw()
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [requestDraw])

  return (
    <div ref={containerRef} className="relative size-full overflow-hidden">
      <canvas
        ref={canvasRef}
        className="size-full cursor-grab touch-none select-none active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      />
    </div>
  )
}
