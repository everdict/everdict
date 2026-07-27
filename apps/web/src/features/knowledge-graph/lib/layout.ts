// A dependency-free, DETERMINISTIC force-directed layout (Fruchterman–Reingold). No Math.random — nodes seed on a
// phyllotaxis spiral by index so the same graph always lays out the same way (stable across re-renders), then relax
// under all-pairs repulsion + per-edge attraction + weak centering. O(n²) per iteration; the caller caps node count.

export interface Point {
  x: number
  y: number
}
export interface LayoutEdge {
  source: string
  target: string
}

const GOLDEN_ANGLE = 2.399963229728653 // radians — the phyllotaxis seed angle

export function forceLayout(
  nodeIds: string[],
  edges: LayoutEdge[],
  opts: { width: number; height: number; iterations?: number },
): Map<string, Point> {
  const n = nodeIds.length
  const out = new Map<string, Point>()
  if (n === 0) return out

  const { width: W, height: H } = opts
  const cx = W / 2
  const cy = H / 2
  const margin = 24
  const index = new Map<string, number>(nodeIds.map((id, i) => [id, i]))

  // Ideal edge length for the given area/population.
  const k = 0.85 * Math.sqrt((W * H) / n)

  // Deterministic phyllotaxis seed.
  const px = new Float64Array(n)
  const py = new Float64Array(n)
  const spread = 0.42 * Math.min(W, H)
  for (let i = 0; i < n; i++) {
    const r = spread * Math.sqrt((i + 0.5) / n)
    const a = i * GOLDEN_ANGLE
    px[i] = cx + r * Math.cos(a)
    py[i] = cy + r * Math.sin(a)
  }

  // Edges as index pairs (skip any endpoint not in the node set).
  const pairs: Array<[number, number]> = []
  for (const e of edges) {
    const a = index.get(e.source)
    const b = index.get(e.target)
    if (a !== undefined && b !== undefined && a !== b) pairs.push([a, b])
  }

  const iterations = opts.iterations ?? Math.max(80, Math.min(300, Math.round(12000 / n)))
  let temp = 0.12 * Math.min(W, H)
  const cooling = temp / (iterations + 1)

  const dx = new Float64Array(n)
  const dy = new Float64Array(n)

  for (let iter = 0; iter < iterations; iter++) {
    dx.fill(0)
    dy.fill(0)

    // Repulsion (all pairs).
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let vx = px[i] - px[j]
        let vy = py[i] - py[j]
        let dist = Math.hypot(vx, vy)
        if (dist < 0.01) {
          // Break the tie deterministically (index-derived jitter), never with Math.random.
          vx = ((i * 13 + 7) % 11) / 11 - 0.5
          vy = ((j * 17 + 5) % 11) / 11 - 0.5
          dist = Math.hypot(vx, vy) || 0.01
        }
        const force = (k * k) / dist
        const ux = (vx / dist) * force
        const uy = (vy / dist) * force
        dx[i] += ux
        dy[i] += uy
        dx[j] -= ux
        dy[j] -= uy
      }
    }

    // Attraction (edges).
    for (const [a, b] of pairs) {
      const vx = px[a] - px[b]
      const vy = py[a] - py[b]
      const dist = Math.hypot(vx, vy) || 0.01
      const force = (dist * dist) / k
      const ux = (vx / dist) * force
      const uy = (vy / dist) * force
      dx[a] -= ux
      dy[a] -= uy
      dx[b] += ux
      dy[b] += uy
    }

    // Weak centering + bounded displacement, then cool.
    for (let i = 0; i < n; i++) {
      dx[i] += (cx - px[i]) * 0.012
      dy[i] += (cy - py[i]) * 0.012
      const disp = Math.hypot(dx[i], dy[i]) || 0.01
      const step = Math.min(disp, temp)
      px[i] = Math.max(margin, Math.min(W - margin, px[i] + (dx[i] / disp) * step))
      py[i] = Math.max(margin, Math.min(H - margin, py[i] + (dy[i] / disp) * step))
    }
    temp = Math.max(cooling, temp - cooling)
  }

  for (let i = 0; i < n; i++) out.set(nodeIds[i], { x: px[i], y: py[i] })
  return out
}
