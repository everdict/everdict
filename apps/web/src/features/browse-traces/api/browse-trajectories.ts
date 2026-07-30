'use server'

import { z } from 'zod'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// One sealed trajectory's meta on the OWNED evidence ledger (native-observability N1 "look inward").
// `source` says how the evidence arrived: run (our own execution), otlp (the OTLP door), import
// (materialized pull-ingest). The run id is the home — a row opens the run's detail page.
const trajectoryMetaSchema = z.object({
  runId: z.string(),
  source: z.enum(['run', 'otlp', 'import']),
  eventCount: z.number().int().nonnegative(),
  sealedAt: z.string(),
})
export type TrajectoryMeta = z.infer<typeof trajectoryMetaSchema>

const trajectoriesListResponseSchema = z.object({
  items: z.array(trajectoryMetaSchema),
  nextCursor: z.string().optional(),
})

export type ListTrajectoriesResult =
  | { ok: true; items: TrajectoryMeta[]; nextCursor?: string }
  | { ok: false; error: string }

// One page of the workspace's sealed trajectories, newest first. authZ (runs:read) is the control plane's.
export async function listTrajectoriesAction(
  query: { limit?: number; cursor?: string } = {}
): Promise<ListTrajectoriesResult> {
  const ctx = await authContext()
  try {
    const raw = await controlPlane.listTrajectories(ctx, query)
    const page = trajectoriesListResponseSchema.parse(raw)
    return {
      ok: true,
      items: page.items,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
