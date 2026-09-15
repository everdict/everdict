import { z } from "zod";

// The closed vocabulary of SOURCE kinds — the everdict artifact a knowledge entry was drawn out of. An
// extraction-born entry records it as `extraction.sourceKind` beside `sourceId`: the `(sourceKind, sourceId)` audit
// tuple that traces a proposed claim back to the surface that produced it. The source is not copied; it already exists
// as a domain record and is only cited.
//
// A source kind OVERLAPS but is not identical to a reference type (`NODE_TYPES`): a comment is both, but
// `workspace_settings` and `pr_comment` are sources that are not entity types, and `tag`/`metric`/`image` are entity
// types that are never sources.
//
// GOVERNANCE: CLOSED and PR-gated, and it only GROWS — stored entries parse `extraction.sourceKind` against this list.
// See docs/architecture/workspace-knowledge.md §The accumulation loop.
export const SOURCE_KINDS = [
  // STRUCTURED result records
  "scorecard",
  "run",
  "schedule",

  // STRUCTURED tracker records (the intent stratum — records/tracker.ts)
  "issue",
  "project",
  "initiative",
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
  "workspace_settings", // CI links, GitHub App installs, trace sources, image registries

  // STRUCTURED knowledge records
  "skill",
  "knowledge_entry",

  // TEXT surfaces (extraction)
  "comment",
  "agent_message",
  "pr_comment",

  // AUTHORED — a user or agent deliberately contributing knowledge (via the API / MCP, e.g. from Claude Code)
  "authored",
] as const;

export const SourceKindSchema = z.enum(SOURCE_KINDS);
export type SourceKind = z.infer<typeof SourceKindSchema>;
