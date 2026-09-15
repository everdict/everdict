import type { KnowledgeEntryRecord as ContractKnowledgeEntryRecord } from '@everdict/contracts'
import { z } from 'zod'

// Local runtime-validation schemas for knowledge entries — reified claims, the `/knowledge` library's record. Per the
// web's isolation rule the app keeps its OWN zod v4 schemas (never importing the zod v3 wire schemas) and
// drift-guards their shape against the contract record.

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
  // The extraction provenance — the audit lock of a `proposed` entry. Kept as an attribution even after approval.
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

type AssertAssignable<A extends B, B> = A

// Entry guard: the record fields (coverage excluded — a server-side decoration with no contract type) follow the
// loose-consumer-view rule: the contract record (narrow — a NodeType union where this view keeps a loose string) must
// stay assignable to this view, so a wire rename/retype of an overlapping field fails the web typecheck.
type _EntryGuard = AssertAssignable<
  Pick<ContractKnowledgeEntryRecord, Exclude<keyof KnowledgeEntry, 'coverage'>>,
  Omit<KnowledgeEntry, 'coverage'>
>
