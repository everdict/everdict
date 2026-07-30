import { z } from "zod";
import { KnowledgePinSchema } from "../knowledge/knowledge-node.js";

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

// Where an imported skill came from — the store publication this workspace copied into its own library. A COPY, not a
// subscription: from the moment it lands the workspace owns it (edit it, stamp versions on it), and this is provenance
// only — it lets the store hide an example the workspace already took and lets the detail view name what it started
// from. Everdict's managed skills are exactly that: examples that live in the store until someone takes one.
export const SkillOriginSchema = z.object({
  source: z.string(), // the workspace that published it ("_everdict" for a managed example)
  id: z.string(), // the capability id
  version: z.string(), // the exact version copied (the copy starts its own version line here)
  name: z.string(), // the publication's name at copy time — display only, never re-resolved
});
export type SkillOrigin = z.infer<typeof SkillOriginSchema>;

// A workspace Skill — a reusable, SKILL.md-style procedure the workspace's members OWN (authored here, or copied from a
// store example and owned from then on) and the conversational agent follows for a recurring task. Claude-Code-style
// progressive disclosure, three tiers: the agent
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
  // The entities this skill documents, pinned on the SUBJECT-TIME axis (`{type, key, version?, verifiedVersion?}` —
  // the known-valid interval [version, verifiedVersion]), projected into the knowledge graph as
  // `skill -[about]-> entity@version` edges carrying the interval. Coverage against the entity's present is derived
  // by comparing its latest version to the interval end — knowledge about an earlier point stays valid ABOUT that
  // point (a coordinate, not decay). See docs/architecture/knowledge-graph.md §The time axis.
  refs: z.array(KnowledgePinSchema).max(16).default([]),
  // `private` = personal draft (creator-only) · `workspace` = shared asset (read/use by any member + the agent, manage creator-or-admin).
  visibility: SkillVisibilitySchema,
  // The skill's own semver. The row is the WORKING COPY — members (and the agent, in conversation) edit it freely; a
  // stamp (`POST /skills/:id/versions`) freezes the current content as an immutable SkillVersionRecord and moves this
  // pointer. So `version` names the last content the workspace decided to publish, not every keystroke since. A copy
  // taken from the store starts at the version it was copied from. Defaulted so rows written before stamping existed
  // read back as 1.0.0.
  version: z.string().default("1.0.0"),
  // Present only on a skill copied out of the store — see SkillOriginSchema (provenance, never a live link).
  origin: SkillOriginSchema.optional(),
  createdBy: z.string(), // owner subject
  createdAt: z.string(),
  updatedAt: z.string(),
  // Last time a human/agent confirmed the procedure still matches reality — distinct from `updatedAt` (a skill rots
  // even when untouched). Optional: absent means never verified.
  verifiedAt: z.string().optional(),
});
export type SkillRecord = z.infer<typeof SkillRecordSchema>;

// One stamped version of a skill — an IMMUTABLE snapshot of the content at the moment the members named it. Same
// immutability contract as a registry version (a stamped version is never rewritten; a correction is the next stamp),
// which is what makes "what did this procedure say when we ran that eval?" answerable. The live SkillRecord stays the
// working copy; these are its published points.
export const SkillVersionRecordSchema = z.object({
  skillId: z.string(),
  tenant: z.string(),
  version: z.string(),
  name: z.string(),
  description: z.string(),
  instructions: z.string(),
  files: SkillFilesSchema.default([]),
  refs: z.array(KnowledgePinSchema).max(16).default([]),
  // Why this version exists, in the stamper's words (a changelog line). Optional — a stamp is allowed to be silent.
  note: z.string().max(2_000).optional(),
  stampedBy: z.string(), // the subject who stamped it (a member, or the agent acting for one)
  stampedAt: z.string(),
});
export type SkillVersionRecord = z.infer<typeof SkillVersionRecordSchema>;
