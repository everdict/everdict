'use server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

import { buildScheduleRunTemplate, type CreateScheduleInput } from '../model/build-run-template'

// 화면 갱신은 부른 쪽의 `refresh()` 가 한다 — 여기서 `revalidatePath` 를 부르면 안 된다
// (무효화할 캐시가 없는데, Next 16 은 선언만으로 클라이언트 prefetch 캐시를 통째로 버리고 300ms 쿨다운을
// 건다). 근거는 `docs/web.md` §"A mutation refreshes; it must not revalidate".
export interface UpdateScheduleResult {
  ok: boolean
  error?: string
}

// Server action: edit a schedule's contents (PATCH). AuthZ is enforced by the control plane — editing contents is creator or workspace admin only (may 403).
// runTemplate is replaced wholesale — the form carries the (prefilled) judges/trials/cases so they aren't lost. enabled is left untouched.
export async function updateScheduleAction(
  id: string,
  input: CreateScheduleInput
): Promise<UpdateScheduleResult> {
  const ctx = await authContext()
  const patch = {
    name: input.name,
    cron: input.cron,
    timezone: input.timezone || 'UTC',
    overlapPolicy: input.overlapPolicy || 'skip',
    runTemplate: buildScheduleRunTemplate(input),
  }
  try {
    await controlPlane.updateSchedule(ctx, id, patch)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
