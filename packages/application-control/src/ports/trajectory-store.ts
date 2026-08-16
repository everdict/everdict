import {
  BadRequestError,
  EVERDICT_ATTR,
  OTEL_RESOURCE,
  TRACE_PLANE,
  type TraceEvent,
  type TraceSpan,
  newSpanId,
  traceIdForRun,
} from "@everdict/contracts";
import { eventsToSpans } from "@everdict/domain";

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
  // WHOSE evidence this is (a member subject), when it belongs to one person rather than the workspace: an
  // agent turn's transcript, a sandbox shell's record. Stamped at seal from the run's audience
  // (`runAudience`, @everdict/domain) so the ledger can answer "may this reader see it" from the row alone —
  // a browse page must not have to join the run ledger to stay private, and a page filtered after the fact
  // would be short. Absent = the workspace's evidence (evals, OTLP arrivals, imports).
  owner?: string;
  // WHAT this evidence is, in the run ledger's own vocabulary (`RUN_KINDS`: eval · agent · command · sandbox ·
  // analysis), and the human handle for it (a conversation's title, the case id, the harness id). Denormalized
  // onto the row for the same reason `owner` is: a browse page has to answer "which of these is the agent
  // conversation I just ran" from the row alone — without it every row reads `<uuid> · run · N events` and the
  // evidence is present but unfindable, which is indistinguishable from missing. Absent = evidence that
  // arrived with no run to name it; `source` still says how it got here.
  kind?: string;
  label?: string;
}

// One EMITTER's contribution to a run's trajectory (the multi-plane rung): the agent's own record, the
// orchestrator's account of where it ran, a service under test emitting its own OTel. Segments are how a
// system-level trajectory stays true to "evidence is never rewritten" — a late plane is added BESIDE the
// others, never merged into their bytes, and each keeps its own provenance.
// What a segment's body holds. EXPLICIT, never sniffed from the bytes: sealed evidence is never rewritten,
// so both forms live in the ledger forever and a row has to say which it is (otel-trace-model.md N6).
// `spans` is the record; `events` is the older form — and still the honest one for a black-box harness whose
// point stream could not be dated well enough to assemble.
export type TrajectoryBodyFormat = "events" | "spans";

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
  // ALWAYS present, whatever the body format — this is what makes spans-as-the-record cost judges nothing.
  // For a `spans` body it is the versioned projection (`spansToEvents`), computed by the store on read.
  events: TraceEvent[];
  format: TrajectoryBodyFormat;
  // The record itself, when this segment holds one. Absent for an `events` body — a tree we never had is
  // not a tree we reconstruct at read time.
  spans?: TraceSpan[];
  // The physical attempt that sealed this plane (see SealInput.attemptId). Absent on evidence written before
  // attempts had an identity, and on any producer that does not declare one.
  attemptId?: string;
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

// The orchestrator's account of WHERE the execution ran — a plane of its own, deliberately NOT in
// EXECUTION_EMITTERS: a judge reads what the agent did, not where the scheduler put it.
export const INFRA_EMITTER = "infra";

// Split an execution's raw event stream into the planes it actually contains and seal each. Placement events
// arrive interleaved with the agent's (the backend/runner appends them to the same CaseResult.trace), but they
// are a different emitter on a different clock — `infra.at` is absolute while the agent's `t` counts from the
// in-job start — so merging them into one segment costs both halves: the judged `events` carry scheduler
// noise, and the two clocks share one anchor that fits neither.
//
// Best-effort by contract, like every seal call site it replaces: evidence, never lifecycle. Callers keep
// their `void`/catch discipline.
// It is also where a run's stream becomes the RECORD. The planes are assembled into spans here rather than
// at each emitter because this is the one place every path passes through — managed dispatch, the
// self-hosted runner, a sandbox session — so one assembly serves all of them and no emitter can forget.
// Assembly is refused (and the events sealed as they are) whenever the stream cannot be dated; see
// `eventsToSpans`. The trace id is DERIVED from the run id, so the two planes agree on it without speaking.
export async function sealExecutionPlanes(
  store: Pick<TrajectoryStore, "seal">,
  input: {
    runId: string;
    tenant: string;
    events: TraceEvent[];
    owner?: string;
    t0?: string;
    // What ran — the root span's name. Defaults to the run itself when the caller has nothing better.
    agentName?: string;
    // What this evidence IS and what to call it on a browse row (see TrajectoryMeta.kind/label).
    kind?: string;
    label?: string;
    // WHICH physical attempt is sealing (see SealInput.attemptId). Carried onto BOTH planes, because a run's
    // agent evidence and its placement account come from the same execution and a reader comparing them
    // against a receipt must be able to see that.
    attemptId?: string;
    newSpanId?: () => string;
  },
): Promise<void> {
  const agent: TraceEvent[] = [];
  const infra: TraceEvent[] = [];
  for (const event of input.events) (event.kind === "infra" ? infra : agent).push(event);
  // Identity travels with the evidence on every plane: the infra segment can win the race to create the
  // trajectory, and a row that arrives first must not be the unnamed one.
  const identity = {
    ...(input.owner !== undefined ? { owner: input.owner } : {}),
    ...(input.kind !== undefined ? { kind: input.kind } : {}),
    ...(input.label !== undefined ? { label: input.label } : {}),
    ...(input.attemptId !== undefined ? { attemptId: input.attemptId } : {}),
  };
  const traceId = traceIdForRun(input.runId);
  const mintSpanId = input.newSpanId ?? (() => newSpanId());
  // The placement span, when there is one, is the parent the agent's root hangs under: the job really did
  // run inside the placed unit, and one trace is only one trace if that is written down.
  const placement = placementSpan(infra, { traceId, newSpanId: mintSpanId });

  // The execution's plane seals first so `SealedTrajectory.events` resolves to it even if the second write loses.
  if (agent.length > 0) {
    const spans = eventsToSpans(agent, {
      traceId,
      ...(placement !== undefined ? { parentSpanId: placement.spanId } : {}),
      agentName: input.agentName ?? "run",
      plane: TRACE_PLANE.agent,
      newSpanId: mintSpanId,
    });
    await store.seal({
      runId: input.runId,
      tenant: input.tenant,
      source: "run",
      ...(spans !== undefined ? { spans } : { events: agent }),
      // The execution's own anchor when the caller knows it (an agent turn: the run's start). Without one a
      // relative `t` cannot be laid on a shared axis and the reader keeps this plane on its own.
      ...(input.t0 !== undefined ? { t0: input.t0 } : {}),
      ...identity,
    });
  }
  if (infra.length > 0) {
    // The plane's own anchor: the earliest absolute stamp its emitter reported. Without one the reader keeps
    // this segment on its own axis rather than inventing an offset onto the agent's.
    const t0 = infra
      .map((e) => (e.kind === "infra" ? e.at : undefined))
      .filter((at): at is string => at !== undefined)
      .sort()[0];
    await store.seal({
      runId: input.runId,
      tenant: input.tenant,
      source: "run",
      emitter: INFRA_EMITTER,
      ...(placement !== undefined ? { spans: [placement] } : { events: infra }),
      ...(t0 !== undefined ? { t0 } : {}),
      ...identity,
    });
  }
}

// The orchestrator's account of a run, as ONE span instead of a scatter of instants.
//
// This is the shape the old model could not hold: a self-hosted run's placement was `leased` at t=0 and
// `finished` at t=23262 — two points for a 23-second interval, because `kind:"infra"` was a member of a union
// whose every member is a point. Here the interval is the span and the points are its span EVENTS, which is
// what OTel has always called them. Undefined when the plane carries no absolute time to build one from.
export function placementSpan(
  infra: TraceEvent[],
  ctx: { traceId: string; newSpanId: () => string },
): TraceSpan | undefined {
  const stamps = infra
    .map((e) => (e.kind === "infra" && e.at !== undefined ? Date.parse(e.at) : Number.NaN))
    .filter((ms) => Number.isFinite(ms));
  if (stamps.length === 0) return undefined;
  const startMs = Math.min(...stamps);
  const endMs = Math.max(...stamps);
  const failed = infra.some((e) => e.kind === "infra" && /fail|error|oom|kill/i.test(`${e.event ?? ""} ${e.message}`));
  const first = infra.find((e) => e.kind === "infra");
  const node = infra.find((e) => e.kind === "infra" && e.node !== undefined);
  const unit = infra.find((e) => e.kind === "infra" && e.unit !== undefined);
  return {
    traceId: ctx.traceId,
    spanId: ctx.newSpanId(),
    name: "placement",
    // We are the CLIENT of the orchestrator: the span records our call to it, not its own work.
    kind: "client",
    startedAt: new Date(startMs).toISOString(),
    endedAt: new Date(endMs).toISOString(),
    attributes: {
      [EVERDICT_ATTR.plane]: TRACE_PLANE.placement,
      ...(first?.kind === "infra" && first.service !== undefined ? { [OTEL_RESOURCE.serviceName]: first.service } : {}),
    },
    // The node and the unit are OTel's own resource attributes — naming them ourselves would have been a
    // private key for a public concept.
    resource: {
      ...(node?.kind === "infra" && node.node !== undefined ? { [OTEL_RESOURCE.k8sNodeName]: node.node } : {}),
      ...(unit?.kind === "infra" && unit.unit !== undefined ? { [OTEL_RESOURCE.k8sPodName]: unit.unit } : {}),
    },
    events: infra
      .filter((e): e is Extract<TraceEvent, { kind: "infra" }> => e.kind === "infra" && e.at !== undefined)
      .map((e) => ({
        name: e.event ?? "infra",
        at: e.at ?? new Date(startMs).toISOString(),
        attributes: { message: e.message },
      })),
    status: { code: failed ? "error" : "ok" },
  };
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
  // What this segment's body actually holds. A reader that wants to say "this is the record, not a
  // reconstruction of one" needs to be told; it cannot tell from the events, which look the same either way.
  format: TrajectoryBodyFormat;
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
    format: segment.format,
    ...(segment.emitter === sealed.executionEmitter ? {} : { events: segment.events }),
  }));
}

// ── ASKING FOR AN IDENTITY INSTEAD OF FOR A CLOCK (arch-review 52, wave 7) ───────────────────────────
//
// WHICH attempt's evidence a case's verdict rests on is decided in Postgres, by the commit receipt. The
// evidence store answers a different question by default — "which row sealed first", resolved from a
// `sealed_at` string each writer stamps from its own clock — and those two answers are not the same answer.
// A duplicate seal carrying a backdated stamp (ordinary replica skew; nothing validates the value) then wins
// the read, and the reader is served the ABANDONED attempt's bytes under the run id the receipt named. Both
// halves stay internally consistent, so no digest downstream disagrees; only the join between them is wrong.
//
// This predicate is that join, in one place, so the three store impls cannot answer it differently: a plane
// AGREES with the identity a receipt selected when it declares that identity — or declares none at all.
// Absence is not agreement, but it is not contradiction either: evidence sealed before attempts had a name
// (and every plane whose producer does not declare one — a judge's, a service's) is still this run's
// evidence, and dropping it would decay the record to protect it. A plane declaring a DIFFERENT attempt is
// the one case that must never be served: it is another execution's bytes.
export function segmentDeclaresAttempt(segment: Pick<TrajectorySegment, "attemptId">, attemptId: string): boolean {
  return segment.attemptId === undefined || segment.attemptId === attemptId;
}

// The exact-identity read, applied to an already-resolved trajectory — the shape a store with a UNIQUE key
// per (run, emitter) needs, since it cannot hold two rows for one plane in the first place (Postgres,
// in-memory). ClickHouse states the SAME rule in SQL, because there the duplicates ARE rows and they collapse
// before a caller could filter them.
//
// Undefined when no plane agrees: the answer to "this attempt's evidence" is then honestly nothing, never
// somebody else's execution. `eventCount` is recomputed over the surviving planes for the same reason — a
// count that includes evidence the read did not return describes a trajectory nobody is holding.
export function trajectoryForAttempt(sealed: SealedTrajectory, attemptId: string): SealedTrajectory | undefined {
  const segments = sealed.segments.filter((segment) => segmentDeclaresAttempt(segment, attemptId));
  if (segments.length === 0) return undefined;
  const execution = executionSegment(segments);
  return {
    meta: { ...sealed.meta, eventCount: segments.reduce((sum, s) => sum + s.eventCount, 0) },
    events: execution?.events ?? [],
    ...(execution !== undefined ? { executionEmitter: execution.emitter } : {}),
    segments,
  };
}

// May this reader open this evidence? The read-side half of `TrajectoryMeta.owner`, kept beside the port so
// every surface that serves a sealed trajectory (the ledger's own detail read and its MCP twin) asks the same
// question — the list side asks it in the query instead, for pagination. Unowned evidence is the workspace's.
export function trajectoryReadableBy(meta: TrajectoryMeta, viewer: string): boolean {
  return meta.owner === undefined || meta.owner === viewer;
}

// One page of the store's ledger (metas only — bodies stay behind get()). Cursor = opaque base64 of the
// last row's (sealedAt, runId), newest first — the house pagination shape.
export interface TrajectoryListResult {
  items: TrajectoryMeta[];
  nextCursor?: string;
}

// What a caller offers the ledger. EXACTLY ONE of `events`/`spans` — a body that claims both has two
// sources of truth and the second one is a copy waiting to drift, which is the whole defect N6 removes.
export interface SealInput {
  runId: string;
  tenant: string;
  source: TrajectoryMeta["source"];
  events?: TraceEvent[];
  spans?: TraceSpan[];
  emitter?: string;
  t0?: string;
  // The member this evidence belongs to (see TrajectoryMeta.owner). Set by the FIRST seal — later planes
  // join evidence that already has an owner, so they never need to restate it.
  owner?: string;
  // What this evidence is and what to call it (see TrajectoryMeta.kind/label). Like `owner`, the first seal
  // names it and later planes join something already named.
  kind?: string;
  label?: string;
  // ── WHOSE EVIDENCE THIS IS (review 39 P1) ────────────────────────────────────────────────────────
  //
  // The store keeps the first seal per (run, emitter) — evidence is never rewritten — and a re-drive reuses
  // the run's correlation id on purpose, so a plane could belong to any of the physical executions that ran
  // under it. A reader holding a case's verdict then cannot ask the only question that matters for replay:
  // is this the execution that produced the result I am looking at?
  //
  // `<executionId>#g<generation>` — the same identity the commit receipt carries, so the two can be compared
  // rather than assumed equal. Absent = the producer did not say, which is never the same as agreement.
  attemptId?: string;
}

// The one place the body rule is enforced, so every store impl agrees on what it was handed. Throws rather
// than picking a winner: a caller that offers both has a bug the ledger must not paper over.
export function sealBody(input: SealInput): {
  format: TrajectoryBodyFormat;
  events: TraceEvent[];
  spans?: TraceSpan[];
} {
  if (input.spans !== undefined && input.events !== undefined)
    throw new BadRequestError(
      "BAD_REQUEST",
      { runId: input.runId },
      "a trajectory seal carries events or spans, never both",
    );
  if (input.spans !== undefined) return { format: "spans", events: [], spans: input.spans };
  if (input.events !== undefined) return { format: "events", events: input.events };
  throw new BadRequestError("BAD_REQUEST", { runId: input.runId }, "a trajectory seal carries a body");
}

export interface TrajectoryStore {
  // Seal one emitter's contribution to a run's trajectory. IDEMPOTENT by (runId, emitter) — the first seal
  // for an emitter wins: a retried settle or a judged write-back never rewrites evidence. A seal from a
  // DIFFERENT emitter than the one that created the trajectory is kept as its own segment rather than
  // dropped — that is how a topology run whose services push spans before the agent settles keeps both.
  // `created` says whether THIS call wrote something (false = a re-offer that lost to an earlier seal) —
  // the perception decorator announces only on true, so at-least-once callers never double-emit a fact.
  seal(input: SealInput): Promise<TrajectoryMeta & { created: boolean }>;
  // A run's sealed evidence, workspace-scoped (a foreign run reads undefined — no existence leak).
  //
  // WITHOUT `opts` the store resolves duplicate seals by the CLOCK — first-write-wins over `sealed_at`. That
  // is best-effort by construction and documented as such: the stamp is the writer's own, so the answer is
  // "whose clock was smallest", which is the right answer only for a caller that holds no identity to ask by
  // (the browse ledger, a legacy reader, retention).
  //
  // WITH `opts.attemptId` it is the EXACT-IDENTITY read: the caller already holds the attempt a Postgres
  // receipt (or an fs revision) selected as canonical, and asks for THAT execution's evidence rather than for
  // whatever the clock elected. Planes declaring a different attempt are refused, not substituted, and a run
  // with nothing agreeing reads undefined — see `segmentDeclaresAttempt` for the rule every impl shares.
  get(tenant: string, runId: string, opts?: { attemptId: string }): Promise<SealedTrajectory | undefined>;
  // Browse the workspace's sealed evidence, newest first (N1 "look inward" — Settings › Traces reads OUR
  // store). Metas only: a page never hauls bodies. `viewer` (the member asking) drops evidence owned by
  // someone else IN THE QUERY — filtering afterwards would hand the reader a short page and let one member's
  // chat history crowd out everyone else's traces. Unset = an internal read (retention, metering).
  // `kind` is the run family filter ("show me my agent conversations"), applied in the query beside the owner
  // predicate for the same reason. DECLARED here, not merely honored by the impls: a decorator that
  // destructures the options would otherwise drop it silently and the filter would read as "nothing of this
  // kind exists".
  list(
    tenant: string,
    opts?: { limit?: number; cursor?: string; viewer?: string; kind?: string },
  ): Promise<TrajectoryListResult>;
  // Ingestion accounting (N3's admission lane): what this workspace sealed since `sinceIso`. The STORE is
  // the meter — no separate counter to drift or lose on restart; the door's quota check reads this.
  ingestedSince(tenant: string, sinceIso: string): Promise<{ trajectories: number; events: number }>;
  // Retention (N3): delete trajectories sealed before the cutoff, across tenants (operator policy). Returns
  // how many rows went — the sweep logs it, never silently. No retention configured = keep forever.
  deleteOlderThan(cutoffIso: string): Promise<number>;
}
