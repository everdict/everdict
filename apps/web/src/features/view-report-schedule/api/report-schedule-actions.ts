'use server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Server actions for a View's report schedules (analysis-studio V3/V4) — thin couriers over the control
// plane's schedule surface with runTemplate.report. AuthZ is the control plane's (schedules:write, member+).

// 화면 갱신은 부른 쪽의 `refresh()` 가 한다 — 여기서 `revalidatePath` 를 부르면 안 된다
// (무효화할 캐시가 없는데, Next 16 은 선언만으로 클라이언트 prefetch 캐시를 통째로 버리고 300ms 쿨다운을
// 건다). 근거는 `docs/web.md` §"A mutation refreshes; it must not revalidate".
export interface ReportScheduleActionResult {
  ok: boolean
  error?: string
}

export async function createViewReportScheduleAction(input: {
  viewId: string
  name: string
  cron: string
  timezone?: string
  instructions?: string
  compare?: boolean
}): Promise<ReportScheduleActionResult & { id?: string }> {
  const ctx = await authContext()
  try {
    const rec = await controlPlane.createSchedule<{ id: string }>(ctx, {
      name: input.name,
      cron: input.cron,
      timezone: input.timezone || 'UTC',
      overlapPolicy: 'skip',
      runTemplate: {
        report: {
          view: input.viewId,
          ...(input.instructions?.trim() ? { instructions: input.instructions.trim() } : {}),
          ...(input.compare ? { compare: 'previous-period' as const } : {}),
        },
      },
    })
    return { ok: true, id: rec.id }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// Manual "run now" — fires the headless report turn synchronously; artifactId is the pinned report (absent when
// the turn produced no report artifact).
export async function fireReportScheduleAction(
  id: string
): Promise<ReportScheduleActionResult & { artifactId?: string }> {
  const ctx = await authContext()
  try {
    const res = await controlPlane.fireSchedule<{ artifactId?: string }>(ctx, id)
    return { ok: true, ...(res.artifactId !== undefined ? { artifactId: res.artifactId } : {}) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function setReportScheduleEnabledAction(
  id: string,
  enabled: boolean
): Promise<ReportScheduleActionResult> {
  const ctx = await authContext()
  try {
    await controlPlane.updateSchedule(ctx, id, { enabled })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function deleteReportScheduleAction(id: string): Promise<ReportScheduleActionResult> {
  const ctx = await authContext()
  try {
    await controlPlane.deleteSchedule(ctx, id)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
