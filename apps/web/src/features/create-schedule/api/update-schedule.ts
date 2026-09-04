'use server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

import { buildScheduleRunTemplate, type CreateScheduleInput } from '../model/build-run-template'

// Refreshing the screen is the CALLER's `refresh()` — `revalidatePath` must not be called here
// (there is no cache to invalidate, and Next 16 throws away the whole client prefetch cache and imposes a 300ms cooldown on the
// DECLARATION alone). The grounds are in `docs/web.md` §"A mutation refreshes; it must not revalidate".
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
