import { z } from "zod";
import { NodeTypeSchema } from "./node-type.js";
import { MentionOriginSchema, SourceKindSchema } from "./source-kind.js";

// The resolution state of a single mention — surface reference → canonical node.
//   • resolved   — mapped to a node (`resolvedNodeId` set). Every HARVEST mention is born resolved.
//   • pending    — an EXTRACTION mention awaiting the resolver.
//   • unresolved — the resolver found no matching node (a dangling reference; kept for audit, not dropped).
export const MENTION_RESOLUTIONS = ["resolved", "pending", "unresolved"] as const;
export const MentionResolutionSchema = z.enum(MENTION_RESOLUTIONS);
export type MentionResolution = z.infer<typeof MentionResolutionSchema>;

// Mention — one observed reference to a node, from one source. This is HALF of the type-agnostic spine (the everdict
// reinterpretation of digo-data's `EntityMention`), and the primary thing this file defines.
//
// Faithful digo locks carried over:
//   • TYPE-AGNOSTIC — one shape carries every `nodeType`; type-specific hints go in `nodeAttrs` jsonb, never per-type
//     columns. Adding a node type never touches this schema.
//   • APPEND-ONLY + AUDITABLE — a mention is never mutated; every re-harvest/re-extraction with a newer `extractor`
//     writes a NEW row, and every mention is traceable to its source (the evidence lock, enforced below).
//   • SURFACE-then-RESOLVE — `nodeRef` is what the source said; canonicalisation is a downstream step recorded in
//     `resolution` / `resolvedNodeId`.
//
// everdict adaptation: `origin` splits the corpus into deterministic HARVEST (structured record foreign-keys —
// `nodeRef` is the exact key, `confidence` 1.0, born resolved, traced by `evidencePath`) and text EXTRACTION (comment/
// agent/PR text — `nodeRef` is a surface form, `confidence` < 1, resolved downstream, traced by `evidenceQuote`).
export const MentionSchema = z
  .object({
    // Deterministic id (domain layer): hash(sourceKind, sourceId, nodeType, nodeRef, extractor). Same input → same id,
    // so re-running a harvester is idempotent and re-running an extractor with a new `extractor` version appends.
    id: z.string().min(1),
    tenant: z.string(),

    // WHAT is referenced (type-agnostic).
    nodeType: NodeTypeSchema,
    nodeRef: z.string().min(1), // exact natural key (harvest) OR surface form as it appeared (extraction)
    nodeAttrs: z.record(z.unknown()).default({}), // type-specific hints (harvest: projected fields; extraction: parsed hints)

    // WHERE it was observed (provenance — the `(sourceKind, sourceId)` audit tuple; no source copy is stored).
    sourceKind: SourceKindSchema,
    sourceId: z.string().min(1),

    // HOW it was drawn out + how confident.
    origin: MentionOriginSchema,
    extractor: z.string().min(1), // e.g. "harvester_v1", "agent:claude-opus-4-8", "mention_regex_v1"
    confidence: z.number().min(0).max(1), // harvest = 1.0

    // EVIDENCE (the audit lock — see the superRefine). Harvest cites the record field path; extraction cites the text.
    evidencePath: z.string().optional(), // harvest: JSON path in the source record, e.g. "origin.scheduleId"
    evidenceQuote: z.string().optional(), // extraction: the text excerpt the reference came from
    evidenceOffsetStart: z.number().int().nonnegative().optional(),
    evidenceOffsetEnd: z.number().int().nonnegative().optional(),
    evidenceLang: z.string().optional(),
    // How central the reference is to its source (main subject vs incidental). Mirrors digo `salience`. Optional.
    salience: z.number().min(0).max(1).optional(),

    // RESOLUTION (downstream): surface reference → canonical node.
    resolution: MentionResolutionSchema.default("pending"),
    resolvedNodeId: z.string().optional(),

    createdAt: z.string(),
  })
  .superRefine((m, ctx) => {
    // Evidence lock: every mention must be traceable to its source. Harvest cites a field path; extraction cites text.
    if (m.origin === "harvest" && (m.evidencePath === undefined || m.evidencePath === "")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidencePath"],
        message: "harvest mention must cite the source record field path (audit lock)",
      });
    }
    if (m.origin !== "harvest" && (m.evidenceQuote === undefined || m.evidenceQuote === "")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidenceQuote"],
        message: "an extraction/authored mention must cite a text excerpt / note (audit lock)",
      });
    }
    // A resolved mention names the node it resolved to.
    if (m.resolution === "resolved" && (m.resolvedNodeId === undefined || m.resolvedNodeId === "")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["resolvedNodeId"],
        message: "a resolved mention must carry resolvedNodeId",
      });
    }
  });
export type Mention = z.infer<typeof MentionSchema>;
