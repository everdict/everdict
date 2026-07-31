'use server'

import { revalidatePath } from 'next/cache'

import { skillSchema, type Skill } from '@/entities/skill'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface ImportSkillActionResult {
  ok: boolean
  skill?: Skill
  error?: string
}

// 스킬 발행물을 워크스페이스에 추가 = **사본 만들기**(POST /skills/import). 다른 kind 처럼 참조를 pin 하는 게 아니라,
// Settings › Agent › Skills 에 워크스페이스 스킬로 들어앉는다 — 그때부터 우리가 고치고 버전을 찍는다.
// everdict 가 스토어에 넣어 둔 매니지드 스킬은 "예제"이므로 이 경로로만 워크스페이스에 들어온다.
export async function importSkillAction(body: {
  source: string
  id: string
  version: string
}): Promise<ImportSkillActionResult> {
  const ctx = await authContext()
  try {
    const skill = skillSchema.parse(await controlPlane.importSkill(ctx, body))
    for (const path of [
      '/[workspace]/store',
      '/[workspace]/store/mine',
      '/[workspace]/settings/skills',
      '/[workspace]/settings/agent',
    ])
      revalidatePath(path)
    // 가져오기를 누르는 자리(스토어 상세) — 동적 세그먼트라 'page' 타입으로 지정해야 매칭된다.
    revalidatePath('/[workspace]/store/[source]/[id]', 'page')
    return { ok: true, skill }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
