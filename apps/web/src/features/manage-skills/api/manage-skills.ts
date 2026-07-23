'use server'

import { revalidatePath } from 'next/cache'

import { generateSkillResultSchema, type GenerateSkillResult, skillSchema, type Skill } from '@/entities/skill'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface SkillActionResult {
  ok: boolean
  skill?: Skill
  error?: string
}

// 스킬 저작(POST /skills). visibility 기본 private. authZ(skills:write)는 컨트롤플레인이 강제.
export async function createSkillAction(body: {
  name: string
  description: string
  instructions: string
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

// 스킬 편집/공유(PATCH /skills/:id). visibility-만 보내면 공유 토글. 관리는 작성자-or-admin(컨트롤플레인).
export async function updateSkillAction(
  id: string,
  patch: { name?: string; description?: string; instructions?: string; visibility?: 'private' | 'workspace' }
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

// 스킬 삭제(DELETE /skills/:id). 작성자-or-admin(컨트롤플레인).
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

// skill-generate — 설명 + 등록 모델 id 로 초안 작성(POST /skills/generate). 영속 안 됨. 실패(모델없음/키없음/업스트림)는 error.
export async function generateSkillAction(description: string, model: string): Promise<GenerateSkillActionResult> {
  const ctx = await authContext()
  try {
    const draft = generateSkillResultSchema.parse(await controlPlane.generateSkill(ctx, { description, model }))
    return { ok: true, draft }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
