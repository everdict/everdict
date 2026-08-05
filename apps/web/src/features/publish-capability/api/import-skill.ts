'use server'

import { skillSchema, type Skill } from '@/entities/skill'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// 화면 갱신은 부른 쪽의 `refresh()` 가 한다 — 여기서 `revalidatePath` 를 부르면 안 된다
// (무효화할 캐시가 없는데, Next 16 은 선언만으로 클라이언트 prefetch 캐시를 통째로 버리고 300ms 쿨다운을
// 건다). 근거는 `docs/web.md` §"A mutation refreshes; it must not revalidate".
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
    return { ok: true, skill }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
