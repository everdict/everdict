import { z } from "zod";

// The closed vocabulary of mention SOURCES — the everdict artifact a mention/edge_mention was observed IN.
//
// The everdict analog of digo-data's `stg_post` / `SUPPORTED_PLATFORMS`: the source is the "document" whose fields or
// text yielded the reference. everdict does NOT copy the source into a staging table (digo normalises multi-platform
// UGC into `stg_post`); the source already exists as a domain record, so a mention just carries `(sourceKind, sourceId)`
// as provenance — the tuple that lets any observation be traced back to what produced it (the audit lock).
//
// Two families of source, distinguished by how references are drawn out (see `MentionOrigin`):
//   • STRUCTURED — deterministic HARVEST from record foreign-keys (a ScorecardRecord already carries harness/dataset/
//     judges/runtime/origin.scheduleId). Confidence is 1.0 and resolution is exact.
//   • TEXT — EXTRACTION from free text (a comment body, an agent turn, a PR comment). Confidence is < 1 and the
//     surface reference is resolved downstream.
//
// A source kind OVERLAPS but is not identical to a node type: a scorecard is both a node and a source; a comment is
// both; but `workspace_settings` and `pr_comment` are sources that are not nodes, and `tag`/`metric`/`image` are nodes
// that are never sources. Adding a source = a new harvester/extractor adapter with the spine unchanged (the digo lock).
// See docs/architecture/knowledge-graph.md §sources.
export const SOURCE_KINDS = [
  // STRUCTURED result records
  "scorecard",
  "run",
  "schedule",

  // STRUCTURED registry specs
  "harness_spec",
  "dataset_spec",
  "judge_spec",
  "rubric_spec",
  "runtime_spec",
  "model_spec",
  "agent_spec",
  "capability_spec",

  // STRUCTURED workspace config
  "view",
  "membership",
  "workspace_settings", // CI links, GitHub App installs, trace sources, image registries — the integration graph

  // TEXT surfaces (extraction)
  "comment",
  "agent_message",
  "pr_comment",

  // AUTHORED — a user or agent deliberately contributing knowledge (via the API / MCP, e.g. from Claude Code)
  "authored",
] as const;

export const SourceKindSchema = z.enum(SOURCE_KINDS);
export type SourceKind = z.infer<typeof SourceKindSchema>;

// How a mention/edge_mention was drawn out of its source — the everdict-specific axis absent from digo-data (whose
// mentions are all LLM-extracted). `harvest` = a deterministic projection of a structured record field (exact,
// confidence 1.0, always resolved). `extraction` = pulled from free text by an agent/regex (fuzzy, confidence < 1,
// resolved downstream). `authored` = a user or agent DELIBERATELY asserted it (via the API / MCP — e.g. from Claude
// Code through the everdict plugin): a first-class contribution, evidence = the author's note/rationale, resolved to
// the node it is about. The SAME type-agnostic spine carries all three — the distinction lets a query separate what
// the system DERIVED from what a person ASSERTED (a trust signal).
export const MENTION_ORIGINS = ["harvest", "extraction", "authored"] as const;
export const MentionOriginSchema = z.enum(MENTION_ORIGINS);
export type MentionOrigin = z.infer<typeof MentionOriginSchema>;
