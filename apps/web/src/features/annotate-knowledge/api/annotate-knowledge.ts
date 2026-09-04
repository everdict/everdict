'use server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// ── CONTRIBUTING TO THE GRAPH ──────────────────────────────────────────────────────────────────────
//
// The web could DRAW the knowledge graph and author nothing in it. A graph a person can only look at is a
// report; the notes and the typed relationships are what make it a place work accumulates.
// docs/architecture/web-runtime-gap-census-spec.md

export interface KnowledgeWriteResult {
  ok: boolean
  error?: string
}

// A free-form note on a node. The author is the CALLER — the control plane stamps it, and nothing here
// sends an author, because a note whose author the client could choose is not attribution.
export async function annotateNodeAction(nodeId: string, note: string): Promise<KnowledgeWriteResult> {
  const ctx = await authContext()
  try {
    await controlPlane.annotateKnowledge(ctx, { node: nodeId, note })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// A TYPED relationship between two nodes. The predicate vocabulary is closed at the control plane, so a
// refusal here means the edge kind does not exist — which is the answer, not an error to paper over.
export async function relateNodesAction(
  from: string,
  to: string,
  predicate: string
): Promise<KnowledgeWriteResult> {
  const ctx = await authContext()
  try {
    await controlPlane.relateKnowledge(ctx, { from, to, predicate })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export interface NodeFacts {
  annotations: { note: string; author?: string; at?: string }[]
  related: { predicate: string; nodeId: string; direction?: string }[]
  error?: string
}

// What is already known ABOUT a node — the notes people wrote and the edges they asserted. Read together
// because the panel shows them together, and one failing read must not hide the other's answer.
export async function loadNodeFacts(nodeId: string): Promise<NodeFacts> {
  const ctx = await authContext()
  const out: NodeFacts = { annotations: [], related: [] }
  try {
    const a = await controlPlane.knowledgeAnnotations<{ annotations?: NodeFacts['annotations'] }>(ctx, nodeId)
    out.annotations = a.annotations ?? []
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e)
  }
  try {
    const r = await controlPlane.knowledgeRelated<{ related?: NodeFacts['related'] }>(ctx, nodeId)
    out.related = r.related ?? []
  } catch (e) {
    out.error = out.error ?? (e instanceof Error ? e.message : String(e))
  }
  return out
}

export interface NodeNeighbourhood {
  node?: { nodeId: string; type?: string; label?: string }
  hops: { nodeId: string; predicate?: string; depth?: number }[]
  error?: string
}

// A multi-hop walk from one node, plus the node's own record. The graph the map draws is capped for
// drawing; this is how a reader asks "and what is BEHIND this one" without re-rendering the whole map.
export async function loadNeighbourhood(nodeId: string, depth: number): Promise<NodeNeighbourhood> {
  const ctx = await authContext()
  const out: NodeNeighbourhood = { hops: [] }
  try {
    out.node = await controlPlane.knowledgeNode<NodeNeighbourhood['node']>(ctx, nodeId)
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e)
  }
  try {
    const g = await controlPlane.knowledgeSubgraph<{ nodes?: NodeNeighbourhood['hops'] }>(ctx, nodeId, depth)
    out.hops = g.nodes ?? []
  } catch (e) {
    out.error = out.error ?? (e instanceof Error ? e.message : String(e))
  }
  return out
}

export interface AgentContextPreview {
  entries: { title?: string; body?: string; freshness?: string }[]
  error?: string
}

// WHAT AN AGENT WOULD BE HANDED for these anchors — the same task-time assembly the runtime performs,
// previewed by a person. Shown rather than described, because "the agent has context about this" is a claim
// somebody has to be able to check before trusting a run that rested on it.
export async function previewAgentContext(anchors: string[]): Promise<AgentContextPreview> {
  const ctx = await authContext()
  try {
    const out = await controlPlane.knowledgeContext<{ entries?: AgentContextPreview['entries'] }>(ctx, {
      anchors,
    })
    return { entries: out.entries ?? [] }
  } catch (e) {
    return { entries: [], error: e instanceof Error ? e.message : String(e) }
  }
}
