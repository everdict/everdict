import type { TraceEvent } from "@everdict/contracts";

// The OWNED trajectory record (execution-model §6 / P5, native-observability rung 1): what happened, kept by
// US — the copy every judgment stands on ("never judge what you don't retain"). Rung 1 collapses live-append
// and seal into one write (eval traces arrive whole at settle) and keeps the body in Postgres jsonb — the
// same bytes the run row embeds today, so no size regression and NO evidence decay (presigned-URL offload
// would rot; the object-storage rung arrives with key-based refs). The port keeps rung 2 (ClickHouse) a
// swap, not a rewrite.
export interface TrajectoryMeta {
  runId: string;
  tenant: string;
  // Where the trajectory came from: our own execution, the OTLP door (N0), or a materialized import (a
  // pulled external trace copied BEFORE judging — provenance, not a live link). This is how the trajectory
  // FIRST arrived; a later emitter's segment carries its own source.
  source: "run" | "otlp" | "import";
  // Every event the trajectory holds, across all emitters — what the browse row counts and what ingestion
  // metering bills.
  eventCount: number;
  sealedAt: string;
}

// One EMITTER's contribution to a run's trajectory (the multi-plane rung): the agent's own record, the
// orchestrator's account of where it ran, a service under test emitting its own OTel. Segments are how a
// system-level trajectory stays true to "evidence is never rewritten" — a late plane is added BESIDE the
// others, never merged into their bytes, and each keeps its own provenance.
export interface TrajectorySegment {
  // Who produced these events: `run` | `otlp` | `import` (the execution's own record, by arrival channel)
  // or `service:<service.name>` for a service under test that pushed its own spans through the door.
  emitter: string;
  source: TrajectoryMeta["source"];
  eventCount: number;
  // Absolute wall-clock (ISO) that this segment's relative `t` counts from — the cross-plane alignment
  // anchor. Absent when the emitter did not report one: a reader keeps that segment on its own axis
  // rather than inventing an offset.
  t0?: string;
  sealedAt: string;
  events: TraceEvent[];
}

// What a trajectory read returns. `events` is the EXECUTION's own evidence (unchanged semantics — the
// stream judges score and sinks export); `segments` is the whole system record, primary first.
// `executionEmitter` names which segment `events` came from, so a reader never has to guess (or re-derive
// the resolution order) to tell the execution's plane from a service's.
export interface SealedTrajectory {
  meta: TrajectoryMeta;
  events: TraceEvent[];
  executionEmitter?: string;
  segments: TrajectorySegment[];
}

// The emitter a seal defaults to when the caller names none — the arrival channel itself.
export function defaultEmitter(source: TrajectoryMeta["source"]): string {
  return source;
}

// The emitters that carry the EXECUTION's own evidence (as opposed to a service under test). `events` on a
// read resolves to the first of these that is present, so an early service arrival can never displace the
// agent's trace as what a judge reads.
export const EXECUTION_EMITTERS: readonly string[] = ["run", "import", "otlp"];

// The execution's own record among the segments — the source of `SealedTrajectory.events`. Shared by every
// store impl so "what a judge reads" cannot drift between Postgres, ClickHouse and in-memory. Falls back to
// the header segment: a trajectory made only of service planes still reads as something.
export function executionSegment(segments: TrajectorySegment[]): TrajectorySegment | undefined {
  for (const emitter of EXECUTION_EMITTERS) {
    const segment = segments.find((s) => s.emitter === emitter);
    if (segment) return segment;
  }
  return segments[0];
}

// One emitter's contribution as it goes over the wire. The EXECUTION segment omits `events` — its stream
// is the response's top-level `events` (the one a judge reads), so a system-level read never ships the same
// trace twice. Every other segment carries its own events: that IS the point of the multi-plane rung.
export interface TrajectorySegmentWire {
  emitter: string;
  source: TrajectoryMeta["source"];
  eventCount: number;
  t0?: string;
  sealedAt: string;
  events?: TraceEvent[];
}

// Shared by every surface that serves a trajectory — GET /trajectories/:id, GET /runs/:id/trajectory and
// the get_trajectory MCP tool — so the shape has exactly one owner and BFF↔MCP parity is structural.
export function trajectorySegmentsWire(sealed: SealedTrajectory): TrajectorySegmentWire[] {
  return sealed.segments.map((segment) => ({
    emitter: segment.emitter,
    source: segment.source,
    eventCount: segment.eventCount,
    ...(segment.t0 !== undefined ? { t0: segment.t0 } : {}),
    sealedAt: segment.sealedAt,
    ...(segment.emitter === sealed.executionEmitter ? {} : { events: segment.events }),
  }));
}

// One page of the store's ledger (metas only — bodies stay behind get()). Cursor = opaque base64 of the
// last row's (sealedAt, runId), newest first — the house pagination shape.
export interface TrajectoryListResult {
  items: TrajectoryMeta[];
  nextCursor?: string;
}

export interface TrajectoryStore {
  // Seal one emitter's contribution to a run's trajectory. IDEMPOTENT by (runId, emitter) — the first seal
  // for an emitter wins: a retried settle or a judged write-back never rewrites evidence. A seal from a
  // DIFFERENT emitter than the one that created the trajectory is kept as its own segment rather than
  // dropped — that is how a topology run whose services push spans before the agent settles keeps both.
  // `created` says whether THIS call wrote something (false = a re-offer that lost to an earlier seal) —
  // the perception decorator announces only on true, so at-least-once callers never double-emit a fact.
  seal(input: {
    runId: string;
    tenant: string;
    source: TrajectoryMeta["source"];
    events: TraceEvent[];
    emitter?: string;
    t0?: string;
  }): Promise<TrajectoryMeta & { created: boolean }>;
  get(tenant: string, runId: string): Promise<SealedTrajectory | undefined>;
  // Browse the workspace's sealed evidence, newest first (N1 "look inward" — Settings › Traces reads OUR
  // store). Metas only: a page never hauls bodies.
  list(tenant: string, opts?: { limit?: number; cursor?: string }): Promise<TrajectoryListResult>;
  // Ingestion accounting (N3's admission lane): what this workspace sealed since `sinceIso`. The STORE is
  // the meter — no separate counter to drift or lose on restart; the door's quota check reads this.
  ingestedSince(tenant: string, sinceIso: string): Promise<{ trajectories: number; events: number }>;
  // Retention (N3): delete trajectories sealed before the cutoff, across tenants (operator policy). Returns
  // how many rows went — the sweep logs it, never silently. No retention configured = keep forever.
  deleteOlderThan(cutoffIso: string): Promise<number>;
}
