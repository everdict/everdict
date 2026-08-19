'use server'

import { z } from 'zod'

import { traceEventSchema, type TraceEvent } from '@/entities/trace'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// One sealed trajectory's meta on the OWNED evidence ledger (native-observability N1 "look inward").
// `source` says how the evidence arrived: run (our own execution), otlp (the OTLP door), import
// (materialized pull-ingest). The id is whatever the evidence was sealed under — a run record's id only
// for source "run", so the detail opens through the ledger's own read, not the run page.
const trajectoryMetaSchema = z.object({
  runId: z.string(),
  source: z.enum(['run', 'otlp', 'import']),
  eventCount: z.number().int().nonnegative(),
  sealedAt: z.string(),
  // WHAT this evidence is (the run family) and its human handle — without them every row reads as a bare
  // uuid and a member cannot tell their own agent conversation from an eval case. Absent on evidence that
  // arrived with no run to name it (and on a control plane older than the identity columns).
  kind: z.string().optional(),
  label: z.string().optional(),
  // What the evidence was ASKED to do, derived from its own body at seal (mig 0168). The label names the
  // PRODUCER — for an agent run it is the agent id, so every turn of one conversation carries the same one —
  // and this is the line that tells two of its rows apart. Absent on evidence sealed before the column
  // existed, and on a body that carried no phrase worth quoting.
  preview: z.string().optional(),
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
  query: { limit?: number; cursor?: string; kind?: string } = {}
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

// One EMITTER's contribution to the trajectory — the execution's own record, plus one per service that
// pushed its own OTel spans through the door (`service:<service.name>`). `t0` is the absolute instant this
// segment's relative `t` counts from: the anchor that lets planes share one time axis.
const trajectorySegmentSchema = z.object({
  emitter: z.string(),
  source: z.enum(['run', 'otlp', 'import']),
  eventCount: z.number().int().nonnegative(),
  t0: z.string().optional(),
  sealedAt: z.string(),
  // Omitted on exactly one segment — the execution's, whose stream is the response's top-level `events`
  // (the wire never ships the same trace twice). Rehydrated below so callers see a uniform list.
  events: z.array(traceEventSchema).optional(),
  // What the ledger actually holds for this plane: the OTel span RECORD, or the older point-event stream a
  // black-box harness gave us. The events read the same either way — this is how a reader can say which it
  // is looking at. Absent on a control plane that predates N6 (otel-trace-model.md).
  format: z.enum(['events', 'spans']).optional(),
})
export type TrajectorySegment = Omit<z.infer<typeof trajectorySegmentSchema>, 'events'> & {
  events: TraceEvent[]
}

const trajectoryDetailSchema = z.object({
  meta: trajectoryMetaSchema,
  events: z.array(traceEventSchema).default([]),
  segments: z.array(trajectorySegmentSchema).default([]),
})

export type GetTrajectoryResult =
  | { ok: true; meta: TrajectoryMeta; events: TraceEvent[]; segments: TrajectorySegment[] }
  | { ok: false; error: string }

// One sealed trajectory's full evidence — the ledger's own detail read (GET /trajectories/:id), which
// unlike the run-scoped twin opens otlp arrivals and materialized imports too. authZ (runs:read) is the
// control plane's.
export async function getTrajectoryAction(runId: string): Promise<GetTrajectoryResult> {
  const ctx = await authContext()
  try {
    const detail = trajectoryDetailSchema.parse(await controlPlane.getTrajectory(ctx, runId))
    const segments: TrajectorySegment[] = detail.segments.map((segment) => ({
      ...segment,
      events: segment.events ?? detail.events,
    }))
    return {
      ok: true,
      meta: detail.meta,
      events: detail.events,
      // A control plane that predates the multi-plane rung sends no segments — the execution's own stream
      // is then the whole trajectory, and the view reads it as a single plane.
      segments:
        segments.length > 0
          ? segments
          : [
              {
                emitter: detail.meta.source,
                source: detail.meta.source,
                eventCount: detail.events.length,
                sealedAt: detail.meta.sealedAt,
                events: detail.events,
              },
            ],
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
