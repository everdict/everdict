'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface ScheduleActionResult {
  ok: boolean
  error?: string
}

// 예약 pause/resume — enabled 토글. authZ 는 컨트롤플레인(schedules:write).
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

// 예약 삭제.
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
