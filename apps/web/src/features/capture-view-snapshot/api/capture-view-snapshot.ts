'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

const captureResultSchema = z.object({
  path: z.string(),
  capturedAt: z.string(),
  totals: z.object({ scorecards: z.number().int(), cases: z.number().int() }),
})
export type CaptureResult = z.infer<typeof captureResultSchema>

// Capture the View onto the workspace filesystem. The control plane computes the analysis server-side and
// writes the file, so nothing about the numbers is decided here — the web only asks and reports where it landed.
export async function captureViewSnapshot(
  workspace: string,
  viewId: string
): Promise<{ ok: true; result: CaptureResult } | { ok: false; error: string }> {
  try {
    const ctx = await authContext()
    const result = captureResultSchema.parse(await controlPlane.captureViewSnapshot(ctx, viewId))
    revalidatePath(`/${workspace}/view/${viewId}`)
    return { ok: true, result }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
