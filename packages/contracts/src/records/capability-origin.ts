import { z } from "zod";

// WHERE A REGISTERED VERSION CAME FROM — the birth stamp of a harness/dataset/judge/rubric/model/agent/runtime
// version. `created_by` already answers WHO registered it; this answers WHY it exists at all: the issue whose
// problem it was built to evaluate, the scorecard whose failure prompted it, the conversation an agent shaped it
// in. Without it a judge that an agent authored from an issue arrives in the workspace anonymous — the detail
// view can name its creator and its content, and nothing else.
//
// It is METADATA BESIDE the spec, never a field inside it — the same rule `created_by`, `team_id` and version
// tags already follow. Versions are immutable, so putting provenance in the spec would mean re-stating where
// something came from mints a new version of content that did not change, and two versions born from the same
// issue would stop being comparable.
//
// It is also RECORD-EMBEDDED rather than derived from the event log: `judge.registered` facts are swept
// (`deleteOlderThan`), and "why does this judge exist" is a question asked long after. Same reasoning as the
// tracker's durable per-record history.

// The CHANNEL a registration arrived through. A fact about the request, not a judgment about the author — an
// agent's tool call is `mcp` and carries `agentId` besides, so "an agent made this" stays derivable from the
// attribution rather than from a channel that only sometimes means it.
export const CAPABILITY_ORIGIN_CHANNELS = ["web", "mcp", "ci", "import"] as const;
export const CapabilityOriginChannelSchema = z.enum(CAPABILITY_ORIGIN_CHANNELS);
export type CapabilityOriginChannel = z.infer<typeof CapabilityOriginChannelSchema>;

// What a capability was born FROM. A POINTER with the same semantics as an issue link or a platform event's
// subject: unvalidated by design, resolved through the normal RBAC-gated reads at render time. A dangling id
// renders as plain text rather than breaking the page — provenance must survive the deletion of what it names.
export const CAPABILITY_ORIGIN_SOURCE_TYPES = [
  "issue",
  "project",
  "initiative",
  "scorecard",
  "run",
  "trace",
  "harness",
  "dataset",
  "judge",
  "benchmark",
] as const;
export const CapabilityOriginSourceTypeSchema = z.enum(CAPABILITY_ORIGIN_SOURCE_TYPES);
export type CapabilityOriginSourceType = z.infer<typeof CapabilityOriginSourceTypeSchema>;

export const CapabilityOriginRefSchema = z.object({
  type: CapabilityOriginSourceTypeSchema,
  // The STABLE id, never the display name: an issue's identifier is re-minted when it moves team, and a
  // provenance stamp that dies on a team move is worse than none.
  id: z.string().min(1).max(200),
  version: z.string().max(100).optional(),
  // Denormalized display text (`ENG-12 Judge misses truncated answers`), so a detail view draws the chip without
  // a second RBAC-gated fetch — the same denormalization an @-mention's `label` already makes, and for the same
  // reason. It is a SNAPSHOT of what the source was called at the time; the id is what resolves.
  label: z.string().max(200).optional(),
});
export type CapabilityOriginRef = z.infer<typeof CapabilityOriginRefSchema>;

export const CapabilityOriginSchema = z.object({
  via: CapabilityOriginChannelSchema,
  from: CapabilityOriginRefSchema.optional(),
  // The agent that acted, and the conversation it acted in — the same attribution the workspace filesystem
  // already records on a revision, arriving through the same request headers. Absent = a member acted directly.
  agentId: z.string().max(200).optional(),
  agentName: z.string().max(200).optional(),
  conversationId: z.string().max(200).optional(),
  runId: z.string().max(200).optional(), // the ledger run behind the turn (P3)
  note: z.string().max(500).optional(), // free reason, when the caller has one to give
});
export type CapabilityOrigin = z.infer<typeof CapabilityOriginSchema>;
