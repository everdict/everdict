'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

import type { CreateScheduleInput } from './create-schedule'

export interface UpdateScheduleResult {
  ok: boolean
  error?: string
}

// Server action: edit a schedule's contents (PATCH). AuthZ is enforced by the control plane — editing contents is creator or workspace admin only (may 403).
// runTemplate is replaced wholesale, so the existing judges are carried through unchanged to preserve them (the form has no judge field). enabled is left untouched.
export async function updateScheduleAction(
  id: string,
  input: CreateScheduleInput,
  judges: { id: string; version: string }[] = []
): Promise<UpdateScheduleResult> {
  const ctx = await authContext()
  const patch = {
    name: input.name,
    cron: input.cron,
    timezone: input.timezone || 'UTC',
    overlapPolicy: input.overlapPolicy || 'skip',
    runTemplate: {
      dataset: { id: input.datasetId, version: input.datasetVersion || 'latest' },
      harness: { id: input.harnessId, version: input.harnessVersion || 'latest' },
      judges,
      ...(input.runtime ? { runtime: input.runtime } : {}),
      ...(input.concurrency ? { concurrency: input.concurrency } : {}),
    },
  }
  try {
    await controlPlane.updateSchedule(ctx, id, patch)
    revalidatePath('/[workspace]/schedules')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
