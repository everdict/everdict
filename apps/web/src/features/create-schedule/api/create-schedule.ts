'use server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

import { buildScheduleRunTemplate, type CreateScheduleInput } from '../model/build-run-template'

// Re-export the input type so existing importers (the form) keep the same path. The builder itself is NOT re-exported
// here — a 'use server' module may only export async server actions, so callers import it from the model module.

// 화면 갱신은 부른 쪽의 `refresh()` 가 한다 — 여기서 `revalidatePath` 를 부르면 안 된다
// (무효화할 캐시가 없는데, Next 16 은 선언만으로 클라이언트 prefetch 캐시를 통째로 버리고 300ms 쿨다운을
// 건다). 근거는 `docs/web.md` §"A mutation refreshes; it must not revalidate".
export type { CreateScheduleInput } from '../model/build-run-template'

export interface CreateScheduleResult {
  ok: boolean
  id?: string
  error?: string
}

// Server action: create a scheduled (cron) scorecard. AuthZ is enforced by the control plane (schedules:write — member+, may 403).
// The firing run executes as the creator's identity (budget → workspace). No version given = latest.
export async function createScheduleAction(
  input: CreateScheduleInput
): Promise<CreateScheduleResult> {
  const ctx = await authContext()
  const body = {
    name: input.name,
    cron: input.cron,
    timezone: input.timezone || 'UTC',
    overlapPolicy: input.overlapPolicy || 'skip',
    runTemplate: buildScheduleRunTemplate(input),
  }
  try {
    const rec = await controlPlane.createSchedule<{ id: string }>(ctx, body)
    return { ok: true, id: rec.id }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
