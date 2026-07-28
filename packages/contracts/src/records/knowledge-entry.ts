import { z } from "zod";
import { KnowledgePinSchema, NodeRefSchema } from "../knowledge/knowledge-node.js";
import { SourceKindSchema } from "../knowledge/source-kind.js";

// A knowledge entry's lifecycle status. `proposed` = an extraction CANDIDATE (drawn from a text surface by the
// extractor, confidence < 1) awaiting human review — approval promotes it to `active` and transfers authorship to the
// approver ("promoted to authored on approval"); rejection deletes it. Knowledge has revision lineage like every
// versioned entity: a re-decision or a refuting observation does not delete the old claim — a new entry `supersedes`
// it (the audit trail survives), and a claim that stopped being useful is `deprecated` in place.
export const KNOWLEDGE_ENTRY_STATUSES = ["proposed", "active", "superseded", "deprecated"] as const;
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

// Extraction provenance — the audit lock for a PROPOSED entry (and, after approval, the retained record of where the
// claim was drawn from): the text surface it came out of (`(sourceKind, sourceId)`, the same audit tuple the mention
// spine uses), the extractor version, and the extractor's confidence (< 1 — extraction is fuzzy by definition).
export const KnowledgeEntryExtractionSchema = z.object({
  sourceKind: SourceKindSchema,
  sourceId: z.string().min(1),
  extractor: z.string().min(1),
  confidence: z.number().min(0).max(1),
});
export type KnowledgeEntryExtraction = z.infer<typeof KnowledgeEntryExtractionSchema>;

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
  // What the claim concerns — subject-time PINS ({type, key, version?, verifiedVersion?}: the known-valid interval
  // [version, verifiedVersion]), projected as `about` edges carrying the interval. The pin's version is the point the
  // claim was observed at; `verify` extends verifiedVersion to the entity's then-latest. A claim about an earlier
  // point is not stale — it is knowledge ABOUT that coordinate; whether it extends to the present is a separate,
  // recorded fact. See docs/architecture/knowledge-graph.md §The time axis.
  refs: z.array(KnowledgePinSchema).max(KNOWLEDGE_ENTRY_MAX_REFS).default([]),
  // What backs the claim — the observations it was drawn from (a scorecard, a run, a comment thread, an agent
  // session), projected as `evidenced_by` edges. An unevidenced entry is allowed (a convention has no scorecard).
  evidence: z.array(NodeRefSchema).max(KNOWLEDGE_ENTRY_MAX_REFS).default([]),
  status: KnowledgeEntryStatusSchema.default("active"),
  supersedes: z.string().optional(), // the entry id this one revises — the graph gets a `supersedes` edge
  // Present on extraction-born entries (proposed AND approved — the origin survives approval for audit).
  extraction: KnowledgeEntryExtractionSchema.optional(),
  visibility: KnowledgeEntryVisibilitySchema,
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  // Last time a human/agent confirmed the claim still holds — distinct from `updatedAt` because knowledge rots even
  // when untouched. Optional: an unverified entry simply has no freshness signal yet.
  verifiedAt: z.string().optional(),
});
export type KnowledgeEntryRecord = z.infer<typeof KnowledgeEntryRecordSchema>;
