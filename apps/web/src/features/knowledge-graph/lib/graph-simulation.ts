// A dependency-free force simulation for the knowledge map — the incremental (per-frame) counterpart of a one-shot
// layout: nodes carry velocity, the caller ticks it inside its animation loop, and it cools to a rest state. That is
// what makes the map feel alive (it settles in front of you, a dragged node pulls its neighbours along) instead of
// snapping to a finished picture.
//
// Deterministic: no Math.random anywhere — nodes seed on a phyllotaxis spiral by index, so the same graph always
// settles into the same picture. Coordinates are WORLD units centred on the origin; the renderer owns pan/zoom.

export interface SimulationNode {
  id: string
  x: number
  y: number
  vx: number
  vy: number
  degree: number
  // Held by the pointer (or explicitly parked) — forces still act on its neighbours, but it stays where it is put.
  pinned: boolean
}

export interface SimulationLink {
  a: number
  b: number
}

export interface Simulation {
  nodes: SimulationNode[]
  links: SimulationLink[]
  index: Map<string, number>
  alpha: number
}

export interface SimulationEdge {
  source: string
  target: string
}

const GOLDEN_ANGLE = 2.399963229728653 // radians — the phyllotaxis seed angle

const LINK_DISTANCE = 96 // the spring's rest length
const LINK_STRENGTH = 0.045
const REPULSION = 3200 // many-body strength; force = REPULSION / d²
const REPULSION_RANGE = 520 // beyond this two nodes stop pushing each other (keeps distant clusters compact)
const CENTER_PULL = 0.006 // weak drift back to the origin so nothing escapes the frame
const VELOCITY_DECAY = 0.62
const ALPHA_DECAY = 0.022

// Below this the picture no longer visibly moves — the caller stops ticking (and stops burning frames).
export const ALPHA_MIN = 0.006

export function createSimulation(nodeIds: string[], edges: SimulationEdge[]): Simulation {
  const index = new Map<string, number>(nodeIds.map((id, i) => [id, i]))
  const n = nodeIds.length
  const spread = 40 * Math.sqrt(Math.max(1, n))
  const nodes: SimulationNode[] = nodeIds.map((id, i) => {
    const r = spread * Math.sqrt((i + 0.5) / Math.max(1, n))
    const a = i * GOLDEN_ANGLE
    return { id, x: r * Math.cos(a), y: r * Math.sin(a), vx: 0, vy: 0, degree: 0, pinned: false }
  })
  const links: SimulationLink[] = []
  for (const e of edges) {
    const a = index.get(e.source)
    const b = index.get(e.target)
    if (a === undefined || b === undefined || a === b) continue
    links.push({ a, b })
    nodes[a].degree += 1
    nodes[b].degree += 1
  }
  return { nodes, links, index, alpha: 1 }
}

// Advance one frame. Returns whether the picture is still moving (alpha above the rest threshold).
export function tickSimulation(sim: Simulation): boolean {
  const { nodes, links } = sim
  const n = nodes.length
  if (n === 0) return false
  const alpha = sim.alpha

  // Many-body repulsion (all pairs, range-limited). The node cap upstream keeps this well inside a frame budget.
  for (let i = 0; i < n; i++) {
    const a = nodes[i]
    for (let j = i + 1; j < n; j++) {
      const b = nodes[j]
      let dx = a.x - b.x
      let dy = a.y - b.y
      let d2 = dx * dx + dy * dy
      if (d2 > REPULSION_RANGE * REPULSION_RANGE) continue
      if (d2 < 1) {
        // Coincident — separate them along an index-derived direction (deterministic, never random).
        dx = ((i * 13 + 7) % 11) / 11 - 0.5
        dy = ((j * 17 + 5) % 11) / 11 - 0.5
        d2 = dx * dx + dy * dy || 1
      }
      const d = Math.sqrt(d2)
      const force = (REPULSION / d2) * alpha
      const ux = (dx / d) * force
      const uy = (dy / d) * force
      a.vx += ux
      a.vy += uy
      b.vx -= ux
      b.vy -= uy
    }
  }

  // Springs.
  for (const { a: ai, b: bi } of links) {
    const a = nodes[ai]
    const b = nodes[bi]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const d = Math.hypot(dx, dy) || 0.01
    const force = (d - LINK_DISTANCE) * LINK_STRENGTH * alpha
    const ux = (dx / d) * force
    const uy = (dy / d) * force
    a.vx += ux
    a.vy += uy
    b.vx -= ux
    b.vy -= uy
  }

  // Centring + integrate.
  for (const node of nodes) {
    if (node.pinned) {
      node.vx = 0
      node.vy = 0
      continue
    }
    node.vx -= node.x * CENTER_PULL * alpha
    node.vy -= node.y * CENTER_PULL * alpha
    node.vx *= VELOCITY_DECAY
    node.vy *= VELOCITY_DECAY
    node.x += node.vx
    node.y += node.vy
  }

  sim.alpha = Math.max(0, sim.alpha - sim.alpha * ALPHA_DECAY)
  return sim.alpha > ALPHA_MIN
}

// Warm the simulation back up — after a drag, a filter change, or a "re-arrange" request.
export function reheat(sim: Simulation, alpha = 0.42): void {
  sim.alpha = Math.max(sim.alpha, alpha)
}
