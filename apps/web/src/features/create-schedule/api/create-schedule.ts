'use server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

import { buildScheduleRunTemplate, type CreateScheduleInput } from '../model/build-run-template'

// Re-export the input type so existing importers (the form) keep the same path. The builder itself is NOT re-exported
// here — a 'use server' module may only export async server actions, so callers import it from the model module.

// Refreshing the screen is the CALLER's `refresh()` — `revalidatePath` must not be called here
// (there is no cache to invalidate, and Next 16 throws away the whole client prefetch cache and imposes a 300ms cooldown on the
// DECLARATION alone). The grounds are in `docs/web.md` §"A mutation refreshes; it must not revalidate".
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
