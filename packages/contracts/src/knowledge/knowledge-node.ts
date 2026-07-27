import { z } from "zod";
import { NodeTypeSchema } from "./node-type.js";

// A stable, structural reference to a knowledge node — the generalisation of the existing `AgentReference`
// (`{type,id,version,label}`) that user turns already carry, which is a ready-made harvest source for the `references`
// predicate. `key` is the node's natural key WITHIN its `(tenant, type)`: a registry id, a record UUID, a repo
// "owner/name", a user subject, or a composite like `${datasetId}#${caseId}`. `version` is present only for
// immutable-versioned registry nodes — a knowledge node is version-PINNED (harness web@1.0.0 and web@2.0.0 are
// distinct nodes joined by a `succeeds` edge), so the version participates in node identity.
export const NodeRefSchema = z.object({
  type: NodeTypeSchema,
  key: z.string().min(1),
  version: z.string().optional(),
});
export type NodeRef = z.infer<typeof NodeRefSchema>;

// The resolution state of a node — whether the canonical projection is backed by a live domain record.
//   • resolved  — the node maps to an existing record (every harvested node; a resolved extraction target).
//   • dangling  — a surface reference from text that no record matched (e.g. a comment names a deleted scorecard).
//                 Kept, not dropped — a dangling node is the graph's record of a broken/pending reference.
export const NODE_RESOLUTIONS = ["resolved", "dangling"] as const;
export const NodeResolutionSchema = z.enum(NODE_RESOLUTIONS);
export type NodeResolution = z.infer<typeof NodeResolutionSchema>;

// KnowledgeNode — the canonical projection of an everdict domain entity into the graph (digo-data's per-type entity
// mart, collapsed into ONE type-agnostic table since everdict entities already own canonical identity). It is a
// derived read-model: the reduce layer rebuilds it from the mentions that point at it (evidence aggregation), and for
// harvested nodes it is essentially 1:1 with the source-of-truth record. It never duplicates the record's body — only
// a display `label` and a small type-specific `attrs` bag for rendering/filtering without a re-fetch.
export const KnowledgeNodeSchema = z.object({
  // Stable content-addressed id derived from `(type, tenant, key, version?)` by the domain layer (contracts stay pure —
  // the derivation helper lives in @everdict/domain). Version-pinned; the SSOT for edge subject/object references.
  nodeId: z.string().min(1),
  tenant: z.string(),
  type: NodeTypeSchema,
  key: z.string().min(1),
  version: z.string().optional(),

  // Denormalised display text (so a graph render draws the node without re-fetching the record), mirroring
  // AgentReference.label. e.g. "alice/web-agent@1.2.0", a scorecard's dataset×harness title, a user's display name.
  label: z.string(),
  // Type-specific projected attributes for rendering/filtering — the everdict analog of `entity_attrs`. Small and
  // display-oriented (status, provider, role, createdAt…), NOT a copy of the record. Per-type shape is documented in
  // the design doc, validated by the projector, not by this wire (keeps the node table type-agnostic).
  attrs: z.record(z.unknown()).default({}),

  resolution: NodeResolutionSchema.default("resolved"),

  // Evidence aggregation over the mentions that resolved to this node (append-only mention corpus → reduced counts).
  evidenceCount: z.number().int().nonnegative().default(0),
  firstObservedAt: z.string().optional(),
  lastObservedAt: z.string().optional(),

  createdAt: z.string(),
  updatedAt: z.string(),
});
export type KnowledgeNode = z.infer<typeof KnowledgeNodeSchema>;
