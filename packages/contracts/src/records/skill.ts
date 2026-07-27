import { z } from "zod";

// A skill's scope (workspace skill-share, mirrors the browser-profile / View visibility vocabulary). `private` = a
// personal draft visible/manageable only by its creator; `workspace` = a shared workspace asset any member can see and
// the agent can use, managed by the creator or a workspace admin.
export const SkillVisibilitySchema = z.enum(["private", "workspace"]);
export type SkillVisibility = z.infer<typeof SkillVisibilitySchema>;

// Bounds for a skill's supporting files (the Claude-Code `references/*` reinterpretation): enough for real reference
// material, small enough that a skill row stays a sane jsonb payload.
export const SKILL_FILE_MAX_CHARS = 262_144; // 256 KiB per file
export const SKILL_MAX_FILES = 32;

// A supporting file bundled with a skill — reference material (templates, checklists, long examples) the agent loads
// ON DEMAND via `read_skill_file`, never inlined with the body. Paths are relative, forward-slash, no traversal
// (e.g. "references/pr-template.md").
export const SkillFileSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/, "relative forward-slash path (letters, digits, . _ -)")
    .refine((p) => p.split("/").every((segment) => segment !== ".." && segment !== "."), {
      message: "path must not contain '.' or '..' segments",
    }),
  content: z.string().max(SKILL_FILE_MAX_CHARS),
});
export type SkillFile = z.infer<typeof SkillFileSchema>;

export const SkillFilesSchema = z
  .array(SkillFileSchema)
  .max(SKILL_MAX_FILES)
  .refine((files) => new Set(files.map((f) => f.path)).size === files.length, {
    message: "file paths must be unique",
  });

// A workspace Skill — a reusable, SKILL.md-style procedure the workspace's members AUTHOR (not imported) and the
// conversational agent follows for a recurring task. Claude-Code-style progressive disclosure, three tiers: the agent
// always sees each skill's name + description (cheap), loads the SKILL.md body (`instructions`) on demand via
// `use_skill`, and pulls individual supporting `files` on demand via `read_skill_file` — a big skill is a lean body
// plus reference files, never one giant document. Instructions only (v1) — no executable code; concrete actions come
// from MCP tools. Dual-scoped `private | workspace` (author privately, then "share to workspace"), managed
// creator-or-admin. Skills are a workspace library the members build up together.
export const SkillRecordSchema = z.object({
  id: z.string(),
  tenant: z.string(), // the workspace this skill lives in
  name: z.string(), // short skill name the agent sees (e.g. "scorecard-triage")
  description: z.string(), // when-to-use / what it does — the discovery line the agent reads to decide whether to load it
  instructions: z.string(), // the SKILL.md body — the procedure, loaded into context when the agent invokes the skill
  files: SkillFilesSchema.default([]), // supporting reference files, each loaded individually on demand
  // `private` = personal draft (creator-only) · `workspace` = shared asset (read/use by any member + the agent, manage creator-or-admin).
  visibility: SkillVisibilitySchema,
  createdBy: z.string(), // owner subject
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SkillRecord = z.infer<typeof SkillRecordSchema>;
