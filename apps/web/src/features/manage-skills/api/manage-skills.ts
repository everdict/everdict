'use server'

import { revalidatePath } from 'next/cache'

import {
  generateSkillResultSchema,
  type GenerateSkillResult,
  type SkillFile,
  skillSchema,
  type Skill,
  type SkillTryResult,
  skillTryResultSchema,
} from '@/entities/skill'
import { agentPlane } from '@/shared/lib/agent-plane'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface SkillActionResult {
  ok: boolean
  skill?: Skill
  error?: string
}

// Authoring a skill (POST /skills). visibility defaults to private. files = the attached reference files (the body stays slim). AuthZ (skills:write) is enforced by the control plane.
export async function createSkillAction(body: {
  name: string
  description: string
  instructions: string
  files?: SkillFile[]
  visibility?: 'private' | 'workspace'
}): Promise<SkillActionResult> {
  const ctx = await authContext()
  try {
    const skill = skillSchema.parse(await controlPlane.createSkill(ctx, body))
    revalidatePath('/[workspace]/settings')
    return { ok: true, skill }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// Editing or sharing a skill (PATCH /skills/:id). Sending visibility ALONE toggles sharing. files is replaced whole when given and kept when omitted.
// Management is author-or-admin (the control plane).
export async function updateSkillAction(
  id: string,
  patch: {
    name?: string
    description?: string
    instructions?: string
    files?: SkillFile[]
    visibility?: 'private' | 'workspace'
  }
): Promise<SkillActionResult> {
  const ctx = await authContext()
  try {
    const skill = skillSchema.parse(await controlPlane.updateSkill(ctx, id, patch))
    revalidatePath('/[workspace]/settings')
    return { ok: true, skill }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// Deleting a skill (DELETE /skills/:id). Author-or-admin (the control plane).
export async function deleteSkillAction(id: string): Promise<{ ok: boolean; error?: string }> {
  const ctx = await authContext()
  try {
    await controlPlane.deleteSkill(ctx, id)
    revalidatePath('/[workspace]/settings')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export interface GenerateSkillActionResult {
  ok: boolean
  draft?: GenerateSkillResult
  error?: string
}

// skill-generate — a draft written from a description plus a registered model id (POST /skills/generate). Not persisted. A failure (no model, no key, upstream) comes back as `error`.
export async function generateSkillAction(description: string, model: string): Promise<GenerateSkillActionResult> {
  const ctx = await authContext()
  try {
    const draft = generateSkillResultSchema.parse(await controlPlane.generateSkill(ctx, { description, model }))
    return { ok: true, draft }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export interface TrySkillActionResult {
  ok: boolean
  result?: SkillTryResult
  error?: string
}

// The skill test drive — one real agent turn run against the skill (possibly unsaved) plus a sample request (POST /agent/skills/try, stateless),
// returning the transcript. It verifies "does this skill actually work" BEFORE saving. A failure (model, key, upstream) comes back as `error`.
export async function trySkillAction(
  skill: { name: string; description: string; instructions: string; files?: SkillFile[] },
  message: string
): Promise<TrySkillActionResult> {
  const ctx = await authContext()
  try {
    const result = skillTryResultSchema.parse(await agentPlane.trySkill(ctx, skill, message))
    return { ok: true, result }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
