import { z } from "zod";

// Per-MEMBER overlay on what the workspace's agent carries. The AgentSpec + the workspace's skill library are the
// shared BASELINE — "what this workspace supports". This record is the individual answer to "which of it do I want MY
// agent to actually carry", for both channels: the TOOLS it can call and the SKILLS it follows. So two members of one
// workspace can talk to the same assistant and get different tools and different procedures.
// Absent key ⇒ follow the baseline; explicit true/false ⇒ the member overrode it.
// ⚠️ No secrets and no tool/skill CONTENT here — only decisions, keyed by the stable keys below.

// The stable identity of one entry. Prefixed because the channels have independent id spaces (a first-party default
// id, a (owner,id) capability pair, a workspace-registered MCP server name, an authored skill id):
//   default:<capabilityId>          — a first-party default (owner = FIRST_PARTY_TENANT)
//   capability:<owner>/<id>         — a Store capability (own workspace, mine-only, or adopted cross-tenant)
//   mcp:<serverName>                — a raw MCP server hand-wired on the AgentSpec        (tools only)
//   skill:<skillId>                 — a Skill authored in this workspace                  (skills only)
export const AGENT_PREFERENCE_KEY_PREFIXES = ["default", "capability", "mcp", "skill"] as const;
export type AgentPreferenceKeyPrefix = (typeof AGENT_PREFERENCE_KEY_PREFIXES)[number];

// Where an entry comes from — the tiers both the Tools and the Skills page group by:
//   builtin   — Everdict-authored, every workspace has it unless opted out
//   workspace — shared here: adopted on the AgentSpec, hand-wired there, authored in this workspace, or published
//               workspace-wide
//   personal  — published/drafted private by this member, so only they can put it on their agent
export const AgentToolScopeSchema = z.enum(["builtin", "workspace", "personal"]);
export type AgentToolScope = z.infer<typeof AgentToolScopeSchema>;

// A key → decision map. A key is REMOVED (not set to the baseline value) when the member resets it, so a later change
// to the workspace baseline still reaches them.
const DecisionsSchema = z.record(z.boolean());

export const AgentMemberPreferencesSchema = z.object({
  tenant: z.string(),
  subject: z.string(),
  tools: DecisionsSchema.default({}),
  skills: DecisionsSchema.default({}),
  // The member's own default LLM for their conversations — a REGISTERED model id (`@everdict/registry` models), the
  // same namespace an AgentSpec.model override names. The third channel of this overlay: the tools it can call, the
  // skills it follows, and the model it thinks with. `null` = follow the workspace baseline (AgentSpec.model → the
  // agent server's default), so a later workspace change still reaches them — exactly the reset semantics the
  // decision maps have. A single conversation's own pick (AgentSessionRecord.model) still wins over this.
  model: z.string().nullable().default(null),
  updatedAt: z.string(),
});
export type AgentMemberPreferences = z.infer<typeof AgentMemberPreferencesSchema>;

// Which channel a decision belongs to — the two maps above are stored (and updated) independently.
export const AgentPreferenceChannelSchema = z.enum(["tools", "skills"]);
export type AgentPreferenceChannel = z.infer<typeof AgentPreferenceChannelSchema>;
