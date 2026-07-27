import { z } from "zod";
import { NodeTypeSchema } from "./node-type.js";
import { EdgePolaritySchema, PredicateSchema } from "./predicate.js";
import { MentionOriginSchema, SourceKindSchema } from "./source-kind.js";

// The resolution state of an edge — an edge is `resolved` only when BOTH endpoints resolve to nodes; `pending` while a
// surface-referenced side awaits resolution; `unresolved` when a side dangles (kept for audit, never dropped).
export const EDGE_RESOLUTIONS = ["resolved", "pending", "unresolved"] as const;
export const EdgeResolutionSchema = z.enum(EDGE_RESOLUTIONS);
export type EdgeResolution = z.infer<typeof EdgeResolutionSchema>;

// EdgeMention — one observed relationship between two nodes, from one source. The OTHER half of the type-agnostic
// spine (the everdict reinterpretation of digo-data's `EdgeMention`), and the primary thing this file defines.
//
// Faithful digo locks carried over:
//   • CLOSED predicate vocabulary + TYPE-AGNOSTIC wire — predicate-specific keys live in `edgeAttrs` jsonb, never
//     per-predicate columns. `polarity` is promoted to a first-class field (a negated edge must survive to the graph).
//   • TWO REFERENCE STYLES — a side is named by `*MentionId` (the one-shot / pre-resolution style, when the edge is
//     harvested/extracted alongside its endpoint mentions) XOR by `*NodeId` (the two-step / post-resolution style).
//     Exactly one per side (enforced below), mirroring digo's `idx` XOR `canonical_id`.
//   • APPEND-ONLY + AUDITABLE — never mutated; every observation is traceable to its source.
//
// Direction is fixed by the predicate vocabulary: subject is the dependent/referencing node, object the referenced.
export const EdgeMentionSchema = z
  .object({
    // Deterministic id (domain layer): hash(sourceKind, sourceId, predicate, subject, object, extractor).
    id: z.string().min(1),
    tenant: z.string(),

    predicate: PredicateSchema,

    // SUBJECT — exactly one reference style.
    subjectMentionId: z.string().optional(),
    subjectNodeId: z.string().optional(),
    subjectTypeHint: NodeTypeSchema.optional(), // cross-checked against the referenced mention/node downstream
    // OBJECT — exactly one reference style.
    objectMentionId: z.string().optional(),
    objectNodeId: z.string().optional(),
    objectTypeHint: NodeTypeSchema.optional(),

    // Predicate-specific attributes (`weight`, `role`, diff deltas, validity window, …) — flattened downstream, kept
    // generic here so predicate evolution never bumps the wire. `polarity` is the one cross-cutting key promoted out.
    edgeAttrs: z.record(z.unknown()).default({}),
    polarity: EdgePolaritySchema.default("affirmed"),

    // WHERE observed + HOW drawn out.
    sourceKind: SourceKindSchema,
    sourceId: z.string().min(1),
    origin: MentionOriginSchema,
    extractor: z.string().min(1),
    confidence: z.number().min(0).max(1), // harvest = 1.0

    // EVIDENCE (audit lock — harvest cites the record field path, extraction cites the text excerpt).
    evidencePath: z.string().optional(),
    evidenceQuote: z.string().optional(),
    evidenceOffsetStart: z.number().int().nonnegative().optional(),
    evidenceOffsetEnd: z.number().int().nonnegative().optional(),
    evidenceLang: z.string().optional(),

    resolution: EdgeResolutionSchema.default("pending"),

    createdAt: z.string(),
  })
  .superRefine((e, ctx) => {
    // Exactly one reference style per side (XOR) — mixing is ambiguous, omitting leaves the edge dangling.
    const subjectRefs = [e.subjectMentionId, e.subjectNodeId].filter((r) => r !== undefined && r !== "").length;
    if (subjectRefs !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["subjectNodeId"],
        message: "subject must use exactly one reference style (subjectMentionId XOR subjectNodeId)",
      });
    }
    const objectRefs = [e.objectMentionId, e.objectNodeId].filter((r) => r !== undefined && r !== "").length;
    if (objectRefs !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["objectNodeId"],
        message: "object must use exactly one reference style (objectMentionId XOR objectNodeId)",
      });
    }
    // No self-edge: a node relating to itself via a predicate is meaningless in this vocabulary.
    if (e.subjectMentionId !== undefined && e.subjectMentionId === e.objectMentionId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["objectMentionId"], message: "self-edge is not allowed" });
    }
    if (e.subjectNodeId !== undefined && e.subjectNodeId === e.objectNodeId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["objectNodeId"], message: "self-edge is not allowed" });
    }
    // Evidence lock (same as Mention): harvest cites a field path, extraction cites text.
    if (e.origin === "harvest" && (e.evidencePath === undefined || e.evidencePath === "")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidencePath"],
        message: "harvest edge must cite the source record field path (audit lock)",
      });
    }
    if (e.origin === "extraction" && (e.evidenceQuote === undefined || e.evidenceQuote === "")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidenceQuote"],
        message: "extraction edge must cite a text excerpt (audit lock)",
      });
    }
  });
export type EdgeMention = z.infer<typeof EdgeMentionSchema>;
