import { z } from "zod";
import { AgentToolScopeSchema } from "../../records/agent-member-preference.js";

// GET /agent/skills 200 — the caller's OWN skill set: every procedure the workspace supports, with the effective
// on/off for THEM. The workspace's library says "these skills exist here"; this says which of them the member's agent
// actually follows. Same shape as the tool list (scope tiers: builtin | workspace | personal), minus the tool-only
// fields (a skill has no transport, no write flag and no secrets — it is instructions the agent reads).
export const AgentSkillEntrySchema = z.object({
  key: z.string().describe("Stable key (skill:<id> | capability:<owner>/<id> | default:<id>)"),
  name: z.string().describe("The skill name the model sees in use_skill"),
  description: z.string().describe("When to use it (the model's selection line)"),
  // authored = a Skill record written in this workspace · packaged = a skill-kind capability (published/adopted/built-in)
  origin: z.enum(["authored", "packaged"]),
  scope: AgentToolScopeSchema,
  enabled: z.boolean().describe("Effective for THIS member (baseline ⊕ their override)"),
  baseline: z.boolean().describe("The workspace baseline — enabled !== baseline means the member overrode it"),
  source: z.string().optional().describe("Owner workspace (packaged entries)"),
  version: z.string().optional(),
  shadowedBy: z.string().optional().describe("An enabled skill of the same name already owns the name"),
});
export type AgentSkillEntry = z.infer<typeof AgentSkillEntrySchema>;

export const AgentSkillListResponseSchema = z.object({
  skills: z.array(AgentSkillEntrySchema),
});
export type AgentSkillListResponse = z.infer<typeof AgentSkillListResponseSchema>;
