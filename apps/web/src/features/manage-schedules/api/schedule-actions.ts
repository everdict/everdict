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
