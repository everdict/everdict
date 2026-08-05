'use server'

import { skillSchema, skillVersionSchema, type Skill, type SkillVersion } from '@/entities/skill'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// 화면 갱신은 부른 쪽의 `refresh()` 가 한다 — 여기서 `revalidatePath` 를 부르면 안 된다
// (무효화할 캐시가 없는데, Next 16 은 선언만으로 클라이언트 prefetch 캐시를 통째로 버리고 300ms 쿨다운을
// 건다). 근거는 `docs/web.md` §"A mutation refreshes; it must not revalidate".
export interface StampSkillVersionResult {
  ok: boolean
  skill?: Skill
  stamped?: SkillVersion
  error?: string
}

// 지금 내용을 한 버전으로 찍는다(POST /skills/:id/versions) — "대화로 고치고, 버전을 다시 찍는다"의 뒷단.
// bump=major|minor|patch(기본 patch). 찍힌 버전은 불변이라 예전 버전은 그때 말하던 그대로 남는다.
// 관리 게이트(작성자-or-admin)와 "현재 버전보다 뒤여야 한다"는 규칙은 컨트롤플레인이 강제한다.
export async function stampSkillVersionAction(
  id: string,
  body: { bump?: 'major' | 'minor' | 'patch'; note?: string }
): Promise<StampSkillVersionResult> {
  const ctx = await authContext()
  try {
    const raw = (await controlPlane.stampSkillVersion(ctx, id, body)) as {
      skill: unknown
      stamped: unknown
    }
    const result = {
      skill: skillSchema.parse(raw.skill),
      stamped: skillVersionSchema.parse(raw.stamped),
    }
    return { ok: true, ...result }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
