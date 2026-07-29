import { z } from "zod";
import { AgentToolScopeSchema } from "../../records/agent-member-preference.js";

// GET /agent/tools 200 — the caller's OWN agent toolset: every tool this member can put on their agent, with the
// effective on/off for THEM (scope tiers: builtin | workspace | personal — see AgentToolScopeSchema).
// The page is a list + a switch: no publishing, no catalog, no cross-workspace discovery (that stays in the Store).

export const AgentToolEntrySchema = z.object({
  key: z.string().describe("Stable tool key (default:<id> | capability:<owner>/<id> | mcp:<name>)"),
  name: z.string().describe("The tool name the model sees"),
  description: z.string(),
  type: z.enum(["mcp", "code"]),
  scope: AgentToolScopeSchema,
  enabled: z.boolean().describe("Effective for THIS member (baseline ⊕ their override)"),
  // The workspace baseline for this tool — what a member who never touched it gets. `enabled !== baseline` means the
  // member overrode it, and the UI offers "follow the workspace default" (which deletes their override).
  baseline: z.boolean(),
  writes: z.boolean().describe("The tool can mutate (mcp write servers / non-read-only code)"),
  // Secret NAMES the tool declares, and which of them this member cannot satisfy from the workspace/personal tiers.
  // A tool with missing secrets is listed (so the gap is visible) but the runtime will not offer it.
  requiredSecrets: z.array(z.string()).default([]),
  missingSecrets: z.array(z.string()).default([]),
  // Capability rows only: the owner workspace + pinned version (an adopted cross-tenant tool shows where it came from).
  source: z.string().optional(),
  version: z.string().optional(),
  // A tool the member cannot switch on because a same-named enabled tool already occupies the name (shadowing follows
  // the runtime's own rule). Carries the winner's key so the UI can explain the conflict.
  shadowedBy: z.string().optional(),
});
export type AgentToolEntry = z.infer<typeof AgentToolEntrySchema>;

export const AgentToolListResponseSchema = z.object({
  tools: z.array(AgentToolEntrySchema),
});
export type AgentToolListResponse = z.infer<typeof AgentToolListResponseSchema>;
