'use server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Refreshing the screen is the CALLER's `refresh()` — `revalidatePath` must not be called here
// (there is no cache to invalidate, and Next 16 throws away the whole client prefetch cache and imposes a 300ms cooldown on the
// DECLARATION alone). The grounds are in `docs/web.md` §"A mutation refreshes; it must not revalidate".
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
