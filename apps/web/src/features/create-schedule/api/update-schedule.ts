'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

import type { CreateScheduleInput } from './create-schedule'

export interface UpdateScheduleResult {
  ok: boolean
  error?: string
}

// 서버 액션: 예약 내용 수정(PATCH). authZ 는 컨트롤플레인이 강제 — 내용 편집은 생성자 또는 워크스페이스 admin 만(403 가능).
// runTemplate 은 통째로 교체되므로 기존 judges 는 그대로 실어 보존한다(폼엔 judge 필드가 없음). enabled 는 건드리지 않음.
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
