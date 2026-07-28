import { z } from "zod";
import { NodeRefSchema } from "../knowledge/knowledge-node.js";

// A knowledge entry's lifecycle status. Knowledge has revision lineage like every versioned entity: a re-decision or a
// refuting observation does not delete the old claim — a new entry `supersedes` it (the audit trail survives), and a
// claim that stopped being useful is `deprecated` in place.
export const KNOWLEDGE_ENTRY_STATUSES = ["active", "superseded", "deprecated"] as const;
export const KnowledgeEntryStatusSchema = z.enum(KNOWLEDGE_ENTRY_STATUSES);
export type KnowledgeEntryStatus = z.infer<typeof KnowledgeEntryStatusSchema>;

// A thin classifier for rendering/filtering — NOT a workflow and NOT a per-kind schema (typed claim shapes are the
// too-specific trap; the specificity lives in `body`). `finding` = an observed fact, `decision` = a choice + rationale,
// `convention` = a workspace working agreement, `context` = background a newcomer/agent needs.
export const KNOWLEDGE_ENTRY_KINDS = ["finding", "decision", "convention", "context"] as const;
export const KnowledgeEntryKindSchema = z.enum(KNOWLEDGE_ENTRY_KINDS);
export type KnowledgeEntryKind = z.infer<typeof KnowledgeEntryKindSchema>;

// An entry's scope (mirrors the Skill / browser-profile / View visibility vocabulary). `private` = a personal draft
// only its creator sees; `workspace` = shared workspace knowledge any member (and the agent) reads.
export const KnowledgeEntryVisibilitySchema = z.enum(["private", "workspace"]);
export type KnowledgeEntryVisibility = z.infer<typeof KnowledgeEntryVisibilitySchema>;

// Bounds: enough anchors/evidence for a real claim, small enough that an entry stays an atomic assertion (a claim that
// concerns 30 entities is a document, not an entry — split it).
export const KNOWLEDGE_ENTRY_MAX_REFS = 16;

// KnowledgeEntryRecord — a reified claim: workspace-general, high-level knowledge that is ABOUT domain entities rather
// than a relationship between them ("harness web-agent@2.x is flaky on login cases when run on k8s"). The task-oriented
// complement of a Skill: a skill answers "how do I do this" (a procedure bundle), an entry answers "what is true / why
// we decided" (an assertion). The record is the SSOT; a deterministic harvester projects it into the graph as a
// `knowledge` node with `about` edges (refs) and `evidenced_by` edges (evidence) — the claim stratum's generic grammar.
// See docs/architecture/knowledge-graph.md §The knowledge layer.
export const KnowledgeEntryRecordSchema = z.object({
  id: z.string(),
  tenant: z.string(), // the workspace this knowledge belongs to
  kind: KnowledgeEntryKindSchema,
  title: z.string().min(1).max(300), // the one-line claim itself — becomes the graph node's label
  body: z.string(), // markdown — where the claim's specificity lives (details, caveats, rationale)
  // What the claim concerns — version-PINNED NodeRefs, projected as `about` edges. Pinning is what lets the graph's
  // `succeeds` lineage flag an entry whose subject has moved on (same mechanism as skill staleness).
  refs: z.array(NodeRefSchema).max(KNOWLEDGE_ENTRY_MAX_REFS).default([]),
  // What backs the claim — the observations it was drawn from (a scorecard, a run, a comment thread, an agent
  // session), projected as `evidenced_by` edges. An unevidenced entry is allowed (a convention has no scorecard).
  evidence: z.array(NodeRefSchema).max(KNOWLEDGE_ENTRY_MAX_REFS).default([]),
  status: KnowledgeEntryStatusSchema.default("active"),
  supersedes: z.string().optional(), // the entry id this one revises — the graph gets a `supersedes` edge
  visibility: KnowledgeEntryVisibilitySchema,
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  // Last time a human/agent confirmed the claim still holds — distinct from `updatedAt` because knowledge rots even
  // when untouched. Optional: an unverified entry simply has no freshness signal yet.
  verifiedAt: z.string().optional(),
});
export type KnowledgeEntryRecord = z.infer<typeof KnowledgeEntryRecordSchema>;
