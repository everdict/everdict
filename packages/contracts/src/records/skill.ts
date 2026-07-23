import { z } from "zod";

// A skill's scope (workspace skill-share, mirrors the browser-profile / View visibility vocabulary). `private` = a
// personal draft visible/manageable only by its creator; `workspace` = a shared workspace asset any member can see and
// the agent can use, managed by the creator or a workspace admin.
export const SkillVisibilitySchema = z.enum(["private", "workspace"]);
export type SkillVisibility = z.infer<typeof SkillVisibilitySchema>;

// A workspace Skill — a reusable, SKILL.md-style procedure the workspace's members AUTHOR (not imported) and the
// conversational agent follows for a recurring task (Claude-Code-style progressive disclosure: the agent sees each
// skill's name + description, and loads the full instructions on demand via the `use_skill` tool). Instructions only
// (v1) — no executable code; concrete actions come from MCP tools. Dual-scoped `private | workspace` (author privately,
// then "share to workspace"), managed creator-or-admin. Skills are a workspace library the members build up together.
export const SkillRecordSchema = z.object({
  id: z.string(),
  tenant: z.string(), // the workspace this skill lives in
  name: z.string(), // short skill name the agent sees (e.g. "scorecard-triage")
  description: z.string(), // when-to-use / what it does — the discovery line the agent reads to decide whether to load it
  instructions: z.string(), // the SKILL.md body — the procedure, loaded into context when the agent invokes the skill
  // `private` = personal draft (creator-only) · `workspace` = shared asset (read/use by any member + the agent, manage creator-or-admin).
  visibility: SkillVisibilitySchema,
  createdBy: z.string(), // owner subject
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SkillRecord = z.infer<typeof SkillRecordSchema>;
