import type {
  SkillRecord as ContractSkillRecord,
  SkillVersionRecord as ContractSkillVersionRecord,
} from '@everdict/contracts'
import type { GenerateSkillResult as ContractGenerateSkillResult } from '@everdict/contracts/wire'
import { z } from 'zod'

// Boundary validation for a workspace skill (the SKILL.md-style procedure a member authors) lives only in this zod v4, and the EXPORTED types are pinned to @everdict/contracts (P4).
// `import type` only — the zod v3 schemas do not run in the web.

export const skillVisibilitySchema = z.enum(['private', 'workspace'])
export type SkillVisibility = z.infer<typeof skillVisibilitySchema>

// A skill's attached files (a reinterpretation of claude-code's references/*) — keep the body slim and put long reference material in files. The agent loads them on demand with read_skill_file.
export const skillFileSchema = z.object({
  path: z.string(),
  content: z.string(),
})
export type SkillFile = z.infer<typeof skillFileSchema>

// The version-pinned reference to what the skill documents ({type,key,version?}) — the staleness contract (the skill is marked stale once the target version moves past it).
// `type` is a closed NodeType vocabulary, but the web cannot import the value array, so it is a loose string (the drift guard locks the overlapping fields).
export const skillRefSchema = z.object({
  type: z.string(),
  key: z.string(),
  version: z.string().optional(),
  verifiedVersion: z.string().optional(), // system-owned — a verify EXTENDS the interval [version, verifiedVersion]
})

// The provenance of a skill imported from the store — a COPY, not a subscription (the workspace owns and edits it from the moment it is imported).
// Used only so the catalog can hide "examples already imported" and the detail can say where it started from.
export const skillOriginSchema = z.object({
  source: z.string(), // the publishing workspace ("_everdict" = an everdict-managed example)
  id: z.string(),
  version: z.string(),
  name: z.string(),
})
export type SkillOrigin = z.infer<typeof skillOriginSchema>

// GET /skills · /skills/:id — the whole SkillRecord. visibility: private (a personal draft) | workspace (shared). instructions = the SKILL.md body + files = the attached files.
// verifiedAt = when it was last confirmed "still valid" (distinct from updatedAt — it is not an edit).
// version = the last STAMPED version (the row itself is the working copy — editing is free, and a stamp fixes that content as an immutable version).
export const skillSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  name: z.string(),
  description: z.string(),
  instructions: z.string(),
  files: z.array(skillFileSchema),
  refs: z.array(skillRefSchema).default([]),
  visibility: skillVisibilitySchema,
  version: z.string(),
  origin: skillOriginSchema.optional(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  verifiedAt: z.string().optional(),
})
export const skillsSchema = z.array(skillSchema)
export type Skill = z.infer<typeof skillSchema>

// GET /skills/:id/versions — the stamped versions (newest first). They are immutable snapshots, so an older version still says exactly what it said then.
export const skillVersionSchema = z.object({
  skillId: z.string(),
  tenant: z.string(),
  version: z.string(),
  name: z.string(),
  description: z.string(),
  instructions: z.string(),
  files: z.array(skillFileSchema),
  refs: z.array(skillRefSchema).default([]),
  note: z.string().optional(),
  stampedBy: z.string(),
  stampedAt: z.string(),
})
export const skillVersionsSchema = z.array(skillVersionSchema)
export type SkillVersion = z.infer<typeof skillVersionSchema>

// POST /skills/generate 200 — an AI draft (skill-generate). A pre-save draft for editing, not persisted.
export const generateSkillResultSchema = z.object({
  name: z.string(),
  description: z.string(),
  instructions: z.string(),
  files: z.array(skillFileSchema),
})
export type GenerateSkillResult = z.infer<typeof generateSkillResultSchema>

// POST /agent/skills/try 200 — the skill test-drive transcript (stateless, not persisted). The assistant body plus tool calls (use_skill included).
export const skillTryMessageSchema = z.object({
  role: z.enum(['assistant', 'tool']),
  content: z.string(),
  toolCalls: z.array(z.object({ name: z.string(), arguments: z.string() })).optional(),
  toolCallId: z.string().optional(),
})
export const skillTryResultSchema = z.object({ messages: z.array(skillTryMessageSchema) })
export type SkillTryMessage = z.infer<typeof skillTryMessageSchema>
export type SkillTryResult = z.infer<typeof skillTryResultSchema>

// The drift guard — the record is bound in both directions except `refs` (refs.type is deliberately a loose string, so only contract→web holds there);
// the generation result is bound in both directions (identical shapes).
type AssertAssignable<A extends B, B> = A
type _SkillFwd = AssertAssignable<Omit<Skill, 'refs'>, Omit<ContractSkillRecord, 'refs'>>
type _SkillBack = AssertAssignable<ContractSkillRecord, Skill>
type _VersionFwd = AssertAssignable<Omit<SkillVersion, 'refs'>, Omit<ContractSkillVersionRecord, 'refs'>>
type _VersionBack = AssertAssignable<ContractSkillVersionRecord, SkillVersion>
type _GenFwd = AssertAssignable<GenerateSkillResult, ContractGenerateSkillResult>
type _GenBack = AssertAssignable<ContractGenerateSkillResult, GenerateSkillResult>
