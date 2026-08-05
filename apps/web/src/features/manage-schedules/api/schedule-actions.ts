'use server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// 화면 갱신은 부른 쪽의 `refresh()` 가 한다 — 여기서 `revalidatePath` 를 부르면 안 된다
// (무효화할 캐시가 없는데, Next 16 은 선언만으로 클라이언트 prefetch 캐시를 통째로 버리고 300ms 쿨다운을
// 건다). 근거는 `docs/web.md` §"A mutation refreshes; it must not revalidate".
export interface ScheduleActionResult {
  ok: boolean
  error?: string
}

// Schedule pause/resume — toggles enabled. AuthZ is the control plane's (schedules:write).
export async function setScheduleEnabledAction(
  id: string,
  enabled: boolean
): Promise<ScheduleActionResult> {
  const ctx = await authContext()
  try {
    await controlPlane.updateSchedule(ctx, id, { enabled })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// Delete a schedule.
export async function deleteScheduleAction(id: string): Promise<ScheduleActionResult> {
  const ctx = await authContext()
  try {
    await controlPlane.deleteSchedule(ctx, id)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// Manual "run now" — fire the schedule immediately. Returns the submitted scorecard id so the caller can navigate to it.
// AuthZ is the control plane's (schedules:write). Firing not configured (Temporal-less dev) surfaces as an error.
export async function fireScheduleAction(
  id: string
): Promise<ScheduleActionResult & { scorecardId?: string }> {
  const ctx = await authContext()
  try {
    const res = await controlPlane.fireSchedule<{ scorecardId: string }>(ctx, id)
    return { ok: true, scorecardId: res.scorecardId }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
