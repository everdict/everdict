'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

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
    revalidatePath('/[workspace]/schedules')
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
    revalidatePath('/[workspace]/schedules')
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
    revalidatePath('/[workspace]/schedules')
    return { ok: true, scorecardId: res.scorecardId }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
