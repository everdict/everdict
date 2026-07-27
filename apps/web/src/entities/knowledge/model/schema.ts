import type { EdgeMention as ContractEdgeMention, KnowledgeNode as ContractKnowledgeNode } from '@everdict/contracts'
import { z } from 'zod'

// Local runtime-validation schemas for the knowledge-graph rendering (Settings › Knowledge). Per the web's isolation
// rule the app keeps its OWN zod v4 schemas (never importing the zod v3 wire schemas) and drift-guards their shape
// against the contract records. `type`/`predicate` stay loose strings here — the closed vocabularies are value arrays
// the web may not import, so the UI maps them by string with a fallback (see features/knowledge-graph/lib/node-style).

export const knowledgeNodeSchema = z.object({
  nodeId: z.string(),
  type: z.string(),
  key: z.string(),
  version: z.string().optional(),
  label: z.string(),
  attrs: z.record(z.string(), z.unknown()).default({}),
  resolution: z.string().default('resolved'),
  evidenceCount: z.number().default(0),
})
export type KnowledgeNodeView = z.infer<typeof knowledgeNodeSchema>

export const knowledgeEdgeSchema = z.object({
  id: z.string(),
  predicate: z.string(),
  subjectNodeId: z.string().optional(),
  objectNodeId: z.string().optional(),
  subjectTypeHint: z.string().optional(),
  objectTypeHint: z.string().optional(),
  polarity: z.string().default('affirmed'),
  edgeAttrs: z.record(z.string(), z.unknown()).default({}),
})
export type KnowledgeEdgeView = z.infer<typeof knowledgeEdgeSchema>

export const knowledgeGraphSchema = z.object({
  root: z.string(),
  nodes: z.array(knowledgeNodeSchema),
  edges: z.array(knowledgeEdgeSchema),
  stats: z.object({
    totalNodes: z.number(),
    totalEdges: z.number(),
    nodesByType: z.record(z.string(), z.number()).default({}),
    edgesByPredicate: z.record(z.string(), z.number()).default({}),
  }),
})
export type KnowledgeGraph = z.infer<typeof knowledgeGraphSchema>

// The whole-workspace-graph response has no contract wire type (it is an application-control read-model), so only its
// node/edge element shapes are drift-guarded: the contract record (narrow — a NodeType/Predicate union where this view
// keeps a loose string) must stay assignable to this consumer view, so a wire rename/retype of an OVERLAPPING field
// fails the web typecheck (a Pick of a removed key is itself a compile error). This is the loose-consumer-view guard.
type AssertAssignable<A extends B, B> = A
type _NodeGuard = AssertAssignable<Pick<ContractKnowledgeNode, keyof KnowledgeNodeView>, KnowledgeNodeView>
type _EdgeGuard = AssertAssignable<Pick<ContractEdgeMention, keyof KnowledgeEdgeView>, KnowledgeEdgeView>
