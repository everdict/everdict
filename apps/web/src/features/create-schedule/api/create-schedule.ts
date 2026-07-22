'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

import { buildScheduleRunTemplate, type CreateScheduleInput } from '../model/build-run-template'

// Re-export the input type so existing importers (the form) keep the same path. The builder itself is NOT re-exported
// here — a 'use server' module may only export async server actions, so callers import it from the model module.
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
    revalidatePath('/[workspace]/schedules')
    return { ok: true, id: rec.id }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
