import type {
  EdgeMention as ContractEdgeMention,
  KnowledgeEntryRecord as ContractKnowledgeEntryRecord,
  KnowledgeNode as ContractKnowledgeNode,
} from '@everdict/contracts'
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
  // When the graph last saw this node observed — the detail panel's "as of" line. Absent on a reference node
  // (a pin whose entity nothing has projected yet).
  lastObservedAt: z.string().optional(),
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

// --- knowledge entries: reified claims (the knowledge layer's record) ---

// A version-pinned reference to a domain entity ({type, key, version?}). `type` stays a loose string (the closed
// NodeType vocabulary is a value array the web may not import); the create form offers the common types.
export const nodeRefSchema = z.object({
  type: z.string().min(1),
  key: z.string().min(1),
  version: z.string().optional(),
})
export type NodeRefView = z.infer<typeof nodeRefSchema>

// A knowledge-layer pin: the NodeRef plus the claim's known-valid INTERVAL end along the entity's timeline —
// [version, verifiedVersion]. verifiedVersion is system-owned (verify extends it); the form never authors it.
export const knowledgePinSchema = nodeRefSchema.extend({
  verifiedVersion: z.string().optional(),
})
export type KnowledgePinView = z.infer<typeof knowledgePinSchema>

export const KNOWLEDGE_ENTRY_KINDS = ['finding', 'decision', 'convention', 'context'] as const
export const KNOWLEDGE_ENTRY_STATUSES = ['proposed', 'active', 'superseded', 'deprecated'] as const

// Server-computed subject-time coverage (not part of the record): `behind` = a pin's interval ends before the
// entity's present (the claim is AS-OF an earlier point — still true about it, validity at the present unknown);
// `unverified` = no recent edit or verification on the wall clock. Absent = no signal (treated as current).
export const knowledgeCoverageSchema = z.object({
  state: z.enum(['current', 'behind', 'unverified']),
  gaps: z.array(z.object({ ref: knowledgePinSchema, latest: z.string() })).default([]),
})
export type KnowledgeCoverage = z.infer<typeof knowledgeCoverageSchema>

export const knowledgeEntrySchema = z.object({
  id: z.string(),
  tenant: z.string(),
  kind: z.enum(KNOWLEDGE_ENTRY_KINDS),
  title: z.string(),
  body: z.string(),
  refs: z.array(knowledgePinSchema).default([]),
  evidence: z.array(nodeRefSchema).default([]),
  status: z.enum(KNOWLEDGE_ENTRY_STATUSES).default('active'),
  supersedes: z.string().optional(),
  // 추출 출처 — proposed(제안) 엔트리의 감사 락. 승인 후에도 출처 표시용으로 유지.
  extraction: z
    .object({
      sourceKind: z.string(),
      sourceId: z.string(),
      extractor: z.string(),
      confidence: z.number(),
    })
    .optional(),
  visibility: z.enum(['private', 'workspace']),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  verifiedAt: z.string().optional(),
  coverage: knowledgeCoverageSchema.optional(),
})
export type KnowledgeEntry = z.infer<typeof knowledgeEntrySchema>

// The whole-workspace-graph response has no contract wire type (it is an application-control read-model), so only its
// node/edge element shapes are drift-guarded: the contract record (narrow — a NodeType/Predicate union where this view
// keeps a loose string) must stay assignable to this consumer view, so a wire rename/retype of an OVERLAPPING field
// fails the web typecheck (a Pick of a removed key is itself a compile error). This is the loose-consumer-view guard.
//
// The EDGE the graph endpoint sends is a deliberate RENDER PROJECTION of the stored mention — no audit spine (origin /
// extractor / confidence / evidencePath / …), because that payload exists to be drawn and the spine was two thirds of
// its bytes. Guarding against the record is still right (the projection's fields are the record's), but do not add
// fields here expecting them to arrive: provenance comes from `related` / `node`. See knowledge-graph.md §Rendering.
type AssertAssignable<A extends B, B> = A
type _NodeGuard = AssertAssignable<
  Pick<ContractKnowledgeNode, keyof KnowledgeNodeView>,
  KnowledgeNodeView
>
type _EdgeGuard = AssertAssignable<
  Pick<ContractEdgeMention, keyof KnowledgeEdgeView>,
  KnowledgeEdgeView
>
// Entry guard: the record fields (coverage excluded — a server-side decoration with no contract type) follow the
// same loose-consumer-view rule: the contract record must stay assignable to this view.
type _EntryGuard = AssertAssignable<
  Pick<ContractKnowledgeEntryRecord, Exclude<keyof KnowledgeEntry, 'coverage'>>,
  Omit<KnowledgeEntry, 'coverage'>
>
