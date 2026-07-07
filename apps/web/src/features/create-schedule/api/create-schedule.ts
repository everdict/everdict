'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface CreateScheduleInput {
  name: string
  cron: string
  timezone: string
  overlapPolicy: string
  datasetId: string
  datasetVersion: string
  harnessId: string
  harnessVersion: string
  runtime: string
  concurrency?: number
}

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
    runTemplate: {
      dataset: { id: input.datasetId, version: input.datasetVersion || 'latest' },
      harness: { id: input.harnessId, version: input.harnessVersion || 'latest' },
      ...(input.runtime ? { runtime: input.runtime } : {}),
      ...(input.concurrency ? { concurrency: input.concurrency } : {}),
    },
  }
  try {
    const rec = await controlPlane.createSchedule<{ id: string }>(ctx, body)
    revalidatePath('/[workspace]/schedules')
    return { ok: true, id: rec.id }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
