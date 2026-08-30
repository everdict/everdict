import {
  BadRequestError,
  EVERDICT_ATTR,
  OTEL_RESOURCE,
  type RunUsageSummary,
  TRACE_PLANE,
  type TraceEvent,
  type TraceSpan,
  UpstreamError,
  newSpanId,
  traceIdForRun,
} from "@everdict/contracts";
import {
  type SpanBatchFacts,
  eventsToSpans,
  previewFromEvents,
  sortSpansForProjection,
  spanBatchFacts,
  spansToEvents,
  usageFromTrace,
} from "@everdict/domain";

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
  // The one-line excerpt naming what this trace was asked to do — the user's message, the first tool call,
  // the root span. `label` names the PRODUCER often enough to be useless on its own (every agent turn's
  // label is the agent id, so a page of conversations reads `default <uuid>` twenty times over); this is
  // what tells two rows apart. Derived from the body at seal by the naming decorator when the caller does
  // not supply one, so OTLP arrivals and imports — which have no run record to name them — get it too.
  // Absent = evidence whose body carried no phrase a reader would recognize it by.
  preview?: string;
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

// ── A PLANE'S HEADER CARRIES NO EVENTS (long-horizon OOM) ────────────────────────────────────────────
//
// This type used to hold `events` (and `spans`), so resolving a trajectory meant materializing every plane's
// entire body — several full copies of the largest object in the system, in a SHARED process. See
// `docs/architecture/long-horizon-trace-reads.md`. The header is what a reader needs to decide WHICH plane
// to open and how much is in it; the events come a window at a time, from `TrajectoryStore.events`.
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
  // What this plane's body HOLDS — `spans` when the record is the tree, `events` when it never was. Stated
  // by the row, never sniffed from the bytes (otel-trace-model.md N6). A page from a `spans` plane carries
  // both the record and the versioned projection every judge reads.
  format: TrajectoryBodyFormat;
  // The physical attempt that sealed this plane (see SealInput.attemptId). Absent on evidence written before
  // attempts had an identity, and on any producer that does not declare one.
  attemptId?: string;
  // ── WHAT THE PROJECTION NEEDS THAT A PAGE CANNOT SEE ──────────────────────────────────────────────
  //
  // `spansToEvents` measures every event's `t` from the earliest span in the batch, and decides whether an
  // aggregate span's tokens are a double-count by asking whether ANY chat span in the batch reported its
  // own. Both are properties of the PLANE, and a page projected on its own answers them from the page —
  // restarting the clock at every boundary and double-counting spend on the page that holds the aggregate.
  //
  // So they are derived once, at seal, where the whole plane is in hand, and recorded here as the plane's
  // own provenance (L3). Present only on a `spans` plane; an `events` plane has nothing to project.
  batch?: SpanBatchFacts;
}

// What a trajectory read returns BEFORE anybody asks for events: the whole system record's shape.
// `executionEmitter` names the plane whose stream is the execution's own evidence — the one judges score and
// sinks export — so a reader never has to guess (or re-derive the resolution order) to tell it from a
// service's.
export interface SealedTrajectory {
  meta: TrajectoryMeta;
  executionEmitter?: string;
  segments: TrajectorySegment[];
  // How many of `segments` declare NO attempt, on a read that asked for one (arch-review 53, Wave B). Absent
  // on an unfiltered read and on a read where every plane was attributed. It exists so a viewer can be told
  // that part of what it is looking at is evidence the requested identity does not vouch for — the mix that
  // used to be returned silently. A decision-grade caller uses `trajectoryForDecision`, which refuses it.
  unattributedSegments?: number;
}

// ── ONE WINDOW OVER ONE PLANE ────────────────────────────────────────────────────────────────────────
//
// REQUIRED, not optional, and that is the whole design. An optional window is a request — some caller will
// omit it, and on the one trajectory where it matters that caller takes the process down with it. A required
// one is a protocol (rule `protocol` L1's shape, applied to a read).
//
// `after` is a plain seq rather than an opaque cursor, unlike `list`'s: this is a position inside ONE
// append-only sealed plane, not a keyset over a mutable ordering, so an opaque token would hide a number the
// caller can reason about and gain nothing.
export interface TrajectoryWindow {
  // Which plane. Absent = the execution's own (`executionEmitterOf`), which is what every judge, sink and
  // viewer means by "the trace".
  emitter?: string;
  // Resume AFTER this seq (1-based, exclusive). Absent = from the beginning.
  after?: number;
  // Ceilings, both clamped by the store. `limit` bounds how MANY events a page materializes; `maxBytes`
  // bounds how LARGE it gets, because a hundred events is only a bound if the events are bounded — and
  // until the payload offload lands they are not.
  limit?: number;
  maxBytes?: number;
  // The exact-identity read (see `TrajectoryStore.planes`): a plane declaring a DIFFERENT attempt is refused
  // rather than served. Carried on the window because the refusal has to reach the read that returns bytes,
  // not only the one that lists planes.
  attemptId?: string;
  // ── PUT THE OFFLOADED PAYLOADS BACK (R1) ──────────────────────────────────────────────────────────
  //
  // A payload too large to keep inline was moved to object storage at seal, and the event holds a preview
  // plus an `artifact://` ref (see `OffloadingTrajectoryStore`). DEFAULT FALSE, and that is the point: a read
  // that always resolved would make the page as large as it ever was, one indirection later.
  //
  // A viewer keeps the preview. A caller that SCORES the trace sets this, because scoring an excerpt is
  // scoring different evidence — and it accepts the cost, which is one object fetch per offloaded field in
  // the page and nothing at all for a page that has none.
  resolve?: boolean;
}

export interface TrajectoryEventPage {
  emitter: string;
  format: TrajectoryBodyFormat;
  // The projection every judge and grader reads — always present, whatever the plane's format.
  events: TraceEvent[];
  // The record itself, when this plane holds one. Absent for an `events` plane: a tree we never had is not a
  // tree we reconstruct at read time.
  spans?: TraceSpan[];
  // The plane's batch facts, carried so a caller that has to RE-PROJECT this page (the payload offload's
  // resolve path does, because a spans plane is projected from attributes that may themselves have been
  // moved) reproduces the whole-plane projection rather than the page's. Absent for an `events` plane and
  // for a plane sealed before mig 0200 — the same rows that are not split.
  batch?: SpanBatchFacts;
  // Resume token for the next call. ABSENT means the plane is exhausted — the only signal a streaming reader
  // needs, and the one a `length < limit` heuristic gets wrong the moment a byte budget cuts a page short.
  nextAfter?: number;
  // How many events the plane holds in total, so a viewer can show progress without draining it.
  eventCount: number;
}

// ── …AND WHAT A PAGE CAN FAIL TO BE ──────────────────────────────────────────────────────────────────
//
// `too_large` is the honest answer for a LEGACY row: evidence sealed before mig 0200 lives as one jsonb blob,
// and there is no way to serve a window of it without materializing the whole thing — which is the defect.
// So the store refuses, names the size, and names the repair (`scripts/live/split-trajectory-bodies.mjs`).
//
// It is deliberately NOT an empty page. "We could not serve this" and "there is nothing here" are different
// facts, and collapsing them would let a viewer, a judge and a sink each quietly conclude the run did
// nothing — the strongest possible wrong answer, produced by a size limit (L2).
export type TrajectoryEventsResult =
  | { kind: "page"; page: TrajectoryEventPage }
  // No such trajectory in this workspace, or no plane agreeing with the requested attempt.
  | { kind: "absent" }
  | { kind: "too_large"; storedBytes: number; limitBytes: number; emitter: string };

// The emitter a seal defaults to when the caller names none — the arrival channel itself.
export function defaultEmitter(source: TrajectoryMeta["source"]): string {
  return source;
}

// The emitters that carry the EXECUTION's own evidence (as opposed to a service under test). `events` on a
// read resolves to the first of these that is present, so an early service arrival can never displace the
// agent's trace as what a judge reads.
export const EXECUTION_EMITTERS: readonly string[] = ["run", "import", "otlp"];

// WHICH emitter carries the execution's own evidence, decided from the emitter NAMES alone — the half of
// `executionSegment` that a caller holding no bodies still needs. `usage()` has to answer for exactly the
// plane `get().events` would have come from, and it must do that without reading a body; spelling the
// resolution order a second time there would have diverged the moment either list grew (L3).
// Falls back to the first emitter offered: a trajectory made only of service planes still reads as something.
export function executionEmitterOf(emitters: readonly string[]): string | undefined {
  for (const emitter of EXECUTION_EMITTERS) {
    if (emitters.includes(emitter)) return emitter;
  }
  return emitters[0];
}

// The execution's own record among the segments — the source of `SealedTrajectory.events`. Shared by every
// store impl so "what a judge reads" cannot drift between Postgres, ClickHouse and in-memory.
export function executionSegment(segments: TrajectorySegment[]): TrajectorySegment | undefined {
  const emitter = executionEmitterOf(segments.map((s) => s.emitter));
  return emitter === undefined ? undefined : segments.find((s) => s.emitter === emitter);
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
    // What this evidence IS and what to call it on a browse row (see TrajectoryMeta.kind/label/preview).
    kind?: string;
    label?: string;
    preview?: string;
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
  // trajectory, and a row that arrives first must not be the unnamed one. The preview is derived from the
  // AGENT plane and carried onto the infra one for exactly that reason — placement marks say where a run
  // ran, never what it was asked to do, so a row named by the infra segment alone would be nameless.
  const preview = input.preview ?? previewFromEvents(agent);
  const identity = {
    ...(input.owner !== undefined ? { owner: input.owner } : {}),
    ...(input.kind !== undefined ? { kind: input.kind } : {}),
    ...(input.label !== undefined ? { label: input.label } : {}),
    ...(preview !== undefined ? { preview } : {}),
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

// One emitter's contribution as it goes over the wire — a HEADER, with no events on it.
//
// It used to inline every non-execution plane's whole event array, which is why a system-level read of a
// long-horizon run shipped (and first materialized) every byte of every plane at once. A plane is opened by
// asking for it: `?emitter=<this>` on the same paged read the execution plane uses. `execution` says which
// one the response's own first page came from, so a client knows which plane it already has.
export interface TrajectorySegmentWire {
  emitter: string;
  source: TrajectoryMeta["source"];
  eventCount: number;
  t0?: string;
  sealedAt: string;
  // What this segment's body actually holds. A reader that wants to say "this is the record, not a
  // reconstruction of one" needs to be told; it cannot tell from the events, which look the same either way.
  format: TrajectoryBodyFormat;
  execution: boolean;
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
    execution: segment.emitter === sealed.executionEmitter,
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
  // ── HOW MUCH OF THIS THE IDENTITY ACTUALLY VOUCHES FOR (arch-review 53, Wave B) ──────────────────
  //
  // The filter above keeps planes that declare NOTHING, and that is right for a viewer: evidence sealed
  // before attempts had names, and every plane whose producer does not declare one, is still this run's
  // evidence. It is not right silently. A reader — a person, a judge input, a receipt verification — was
  // handed a mix of "this attempt's bytes" and "bytes nobody attributed" under one type with no field
  // separating them, and consumed attribution it never checked. The count says so now, and
  // `trajectoryForDecision` below refuses the mix outright.
  const unattributed = segments.filter((segment) => segment.attemptId === undefined).length;
  return {
    meta: { ...sealed.meta, eventCount: segments.reduce((sum, s) => sum + s.eventCount, 0) },
    ...(execution !== undefined ? { executionEmitter: execution.emitter } : {}),
    ...(unattributed > 0 ? { unattributedSegments: unattributed } : {}),
    segments,
  };
}

// ── A DECISION READ AND A DISPLAY READ ARE NOT ONE READ (arch-review 53, Wave B) ────────────────────
//
// `trajectoryForAttempt` is the DISPLAY read: it keeps unattributed planes and now says how many it kept.
// This is the other contract. A caller holding a receipt-selected `attemptId` — a gate, a judge input, a
// receipt verification — is asking "give me the bytes THAT attempt produced", and an unattributed plane is
// not an answer to that question. It is an answer to a different one, and returning it under the same type
// is how attribution gets consumed without ever being established.
//
// `undefined` means the evidence this identity vouches for is not here. That is the honest answer, and it is
// the one the decision plane can act on — unlike a plausible mixture it cannot tell apart.
export function trajectoryForDecision(sealed: SealedTrajectory, attemptId: string): SealedTrajectory | undefined {
  const segments = sealed.segments.filter((segment) => segment.attemptId === attemptId);
  if (segments.length === 0) return undefined;
  const execution = executionSegment(segments);
  return {
    meta: { ...sealed.meta, eventCount: segments.reduce((sum, s) => sum + s.eventCount, 0) },
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
  // The work-naming excerpt (see TrajectoryMeta.preview). Callers rarely set it: the naming decorator derives
  // one from the body when it is absent, which is the single choke point every seal path passes through.
  preview?: string;
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
//
// It also DERIVES the body's usage, here, because this is the one function every impl already routes through
// and the events are in hand exactly once — at the write. See `TrajectoryUsage` for why the reader may not
// do this itself.
export function sealBody(input: SealInput): {
  format: TrajectoryBodyFormat;
  events: TraceEvent[];
  spans?: TraceSpan[];
  // The execution economics of THIS body. Absent = the body could not be projected, which the ledger records
  // as unknown rather than as zero — see `usageOfBody`.
  usage?: RunUsageSummary;
  // What a PAGE of this plane will need in order to project identically to the whole (see
  // `TrajectorySegment.batch`). Derived here for the same reason usage is: this is the one moment the whole
  // plane is in hand, and it is the writer's job to record what a later reader cannot re-derive.
  batch?: SpanBatchFacts;
} {
  if (input.spans !== undefined && input.events !== undefined)
    throw new BadRequestError(
      "BAD_REQUEST",
      { runId: input.runId },
      "a trajectory seal carries events or spans, never both",
    );
  if (input.spans !== undefined) {
    const usage = usageOfBody(input.spans);
    // SORTED, because seq order has to BE projection order: the store pages by seq and `spansToEvents` sorts
    // by `startedAt`, so storing arrival order would make page N's spans project in a different position than
    // the whole plane puts them. This reorders ROWS, never bytes — every span is stored verbatim.
    const spans = sortSpansForProjection(input.spans);
    return {
      format: "spans",
      events: [],
      spans,
      batch: spanBatchFacts(spans),
      ...(usage !== undefined ? { usage } : {}),
    };
  }
  if (input.events !== undefined) {
    const usage = usageFromTrace(input.events);
    return { format: "events", events: input.events, usage };
  }
  throw new BadRequestError("BAD_REQUEST", { runId: input.runId }, "a trajectory seal carries a body");
}

// A spans body is metered over the same projection a judge reads, so a span-sealed trajectory and its
// event-sealed twin report the same cost. A body that will not project yields UNDEFINED, never zero: the
// naming decorator states the rule this follows — a malformed body must not fail a seal, because evidence
// retention is the contract and metering is a courtesy to the reader. Zero would be worse than silence here;
// it is a billing-adjacent number, and "we could not derive it" has to stay distinguishable from "it cost
// nothing" all the way to the surface (L2).
function usageOfBody(spans: TraceSpan[]): RunUsageSummary | undefined {
  try {
    return usageFromTrace(spansToEvents(spans));
  } catch {
    return undefined;
  }
}

// ── WHAT A TRAJECTORY COST, ANSWERED WITHOUT READING IT ──────────────────────────────────────────────
//
// The run DETAIL path used to fetch the WHOLE sealed trajectory and fold `usageFromTrace` over it to produce
// five numbers. For a long-horizon run that is hundreds of megabytes of jsonb through pg's `JSON.parse` and
// then through Zod's array parse — a second complete copy — so that a browser could render a cost badge. The
// heap it took was not the tenant's to spend: the OOM killed the shared API process and with it every other
// workspace's in-flight request.
//
// So the WRITER derives it, once, where the events are already in hand (L3), and the reader asks for the
// answer instead of for the evidence.
//
// THREE ANSWERS, because a row sealed before this existed is not a row that cost nothing (L2). Writing a zero
// into those rows would be the "an absence is not a clean bill of health" defect applied to a billing-adjacent
// number — invented evidence, in the one place a reader would never think to doubt it.
// `scripts/live/backfill-trajectory-usage.mjs` repays them through the SAME derivation, one bounded row at a
// time; until it has, they say plainly that nobody knows.
export type TrajectoryUsage =
  | { kind: "derived"; usage: RunUsageSummary }
  // No trajectory with this id in this workspace — the same answer a foreign tenant's id gets, so the union
  // leaks no more existence than `get` does.
  | { kind: "absent" }
  // Sealed before the derivation existed, or from a body that would not project. Never folded into `derived`
  // with zeros, and never into `absent`: the evidence IS here, and what it cost is what we cannot say.
  | { kind: "unknown"; reason: "sealed_before_derivation" };

export interface TrajectoryStore {
  // Seal one emitter's contribution to a run's trajectory. IDEMPOTENT by (runId, emitter) — the first seal
  // for an emitter wins: a retried settle or a judged write-back never rewrites evidence. A seal from a
  // DIFFERENT emitter than the one that created the trajectory is kept as its own segment rather than
  // dropped — that is how a topology run whose services push spans before the agent settles keeps both.
  // `created` says whether THIS call wrote something (false = a re-offer that lost to an earlier seal) —
  // the perception decorator announces only on true, so at-least-once callers never double-emit a fact.
  seal(input: SealInput): Promise<TrajectoryMeta & { created: boolean }>;
  // A run's sealed evidence — its SHAPE, workspace-scoped (a foreign run reads undefined — no existence
  // leak). Meta plus one header per plane, and NO events: see `TrajectorySegment`. The events of a plane are
  // asked for separately, a window at a time.
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
  planes(tenant: string, runId: string, opts?: { attemptId: string }): Promise<SealedTrajectory | undefined>;
  // ONE WINDOW of ONE plane's events. This is the only way to get bytes out of the store, and the window is
  // a required argument for the reason `TrajectoryWindow` gives: a read that CAN return everything will,
  // from some caller, and on a long-horizon run that ends the process.
  //
  // `too_large` is a real answer, not an error: a plane sealed before mig 0200 is one jsonb blob, and a
  // window of a blob costs the whole blob. The store says so, with the size and the repair, rather than
  // trying and dying — and never with an empty page, because "we could not serve this" and "the run did
  // nothing" must not be the same value (L2).
  events(tenant: string, runId: string, window: TrajectoryWindow): Promise<TrajectoryEventsResult>;
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
  // The EXECUTION plane's economics, derived at seal and read back WITHOUT a body — see `TrajectoryUsage`
  // for why the alternative was an availability defect. Every impl resolves which plane that is with
  // `executionEmitterOf` over the emitter NAMES, so this answer and `get().events` can never be about
  // different segments. Declared on the port, not left to the impls: a decorator that forgot to forward it
  // would report every trajectory as costing nothing.
  usage(tenant: string, runId: string): Promise<TrajectoryUsage>;
  // Ingestion accounting (N3's admission lane): what this workspace sealed since `sinceIso`. The STORE is
  // the meter — no separate counter to drift or lose on restart; the door's quota check reads this.
  ingestedSince(tenant: string, sinceIso: string): Promise<{ trajectories: number; events: number }>;
  // Retention (N3): delete trajectories sealed before the cutoff, across tenants (operator policy). Returns
  // how many rows went — the sweep logs it, never silently. No retention configured = keep forever.
  deleteOlderThan(cutoffIso: string): Promise<number>;
  // ── WHAT RETENTION IS ABOUT TO DESTROY THE ONLY POINTER TO (arch-review 120) ─────────────────────
  //
  // An offloaded payload lives in object storage and is named ONLY by the event row that carries its ref. So
  // `deleteOlderThan` removing the rows removes the last enumeration of those objects — the database reports
  // a successful retention and the tenant's evidence bytes stay, with nothing left that could find them.
  //
  //     the rows are gone   ≠   the bytes are gone
  //
  // This is the read that keeps them findable: every payload ref held by the trajectories this cutoff would
  // delete. The offloading decorator drives it BEFORE the delete, because after it there is nothing to ask.
  //
  // REQUIRED, and the first draft of it was optional — which is how it was found. `NamingTrajectoryStore`
  // sits between the offloading decorator and the concrete store, so an optional method it does not forward
  // is `undefined` at the seam that decides, the sweep takes its no-offload arm, and every deployment
  // deletes rows while the bytes stay. That is rule `protocol`'s optional-dependency law exactly: a
  // capability a protocol depends on is required at the seam that decides, or its absence is a named
  // outcome — never a silent `?.` that reads as success. Required, the compiler asks both decorators and
  // all three stores, which is the only reader that cannot forget.
  // ⚠️ IT ANSWERS WITH THE OWNER, AND IT PAGES (arch-review 121). Two defects made both necessary:
  //
  //   · a bare `string[]` let the SWEEP treat any `artifact://…` it found as authority to delete that key —
  //     and a producer can put one in its own trace, because `TraceEvent` is the schema its submissions are
  //     validated by. The row knows which trajectory holds it; answering with `{tenant, runId}` makes
  //     ownership a JOIN the caller can perform (`ownsPayloadKey`) instead of a fact it assumes.
  //   · a single bounded call let the caller delete every expired ROW after accounting for only the first
  //     `limit` REFS, orphaning the rest permanently. `after` is a cursor over `ref` (the rows are ordered by
  //     it), so a sweep drains the enumeration before it deletes anything that names it.
  payloadRefsOlderThan(cutoffIso: string, limit: number, after?: string): Promise<TrajectoryPayloadRef[]>;
}

// One offloaded payload reference, WITH the trajectory that holds it. The pair is the point: a ref alone is
// a string a producer can author, and only the row it was read from says which trajectory it belongs to.
export interface TrajectoryPayloadRef {
  tenant: string;
  runId: string;
  ref: string;
}

// ── WHO OWNS THE BYTES A REF NAMES (arch-review 121) ─────────────────────────────────────────────────
//
// The offload key is `trajectory-payloads/<tenant>/<runId>/<emitter>/<digest>.<field>`, so the object's
// owner is written into its address and no second table is needed to answer this. Both readers ask before
// they act — the resolve before it fetches, the sweep before it deletes — because a forged ref that survives
// one of them is reachable through the other.
//
//     the ref is schema-valid    ≠   the platform minted it
//     the ref is in this record  ≠   this record owns the object
//
// A key that is not ours at all (a handle into somebody else's store entirely) answers false here too, which
// is the fail-closed direction: we neither read it nor delete it.
//
// Compared SEGMENT BY SEGMENT rather than as a string prefix, so the answer does not rest on a precondition
// this package never states. `trajectory-payloads/<a>/<b>/<c>/…` is the prefix of tenant `a` + run `b/c` and
// equally of tenant `a/b` + run `c`; a raw `startsWith` calls both of those the owner. Nothing here validates
// the workspace id — the only charset guard in the repo is `assertFsTenant`, which lives in @everdict/storage
// for the filesystem's own reasons ("a workspace id can never smuggle a separator") and is not on this path.
// Depending on a neighbour package's guard for a tenancy decision is how the assumption would outlive it.
// A tenant that DID contain a separator is then answered false about its own objects, which loses bytes to a
// leak rather than serving them to a stranger — the direction to fail in.
export function ownsPayloadKey(key: string, tenant: string, runId: string): boolean {
  const segments = key.split("/");
  // A key that names no object is nobody's: `trajectory-payloads/<tenant>/<runId>/` sits inside the pair's own
  // namespace and still addresses nothing, so answering "owned" would hand a caller a licence over a
  // coordinate rather than over bytes.
  if (segments.length <= 3 || segments.slice(3).join("/").length === 0) return false;
  return segments[0] === "trajectory-payloads" && segments[1] === tenant && segments[2] === runId;
}

// ── THE PAGE CEILINGS, OWNED ONCE ────────────────────────────────────────────────────────────────────
//
// Every impl clamps through `clampWindow`, so a caller cannot widen a page past what the process can hold by
// asking nicely, and the three stores cannot disagree about what "one page" means.
export const DEFAULT_EVENT_PAGE = 500;
export const MAX_EVENT_PAGE = 5_000;
// 4 MiB of serialized events per page. Chosen so that the whole streaming pipeline — a page, its Zod
// validation copy, and the JSON the transport writes — stays inside a few tens of megabytes per concurrent
// reader, which is the number that matters: the heap is shared.
export const DEFAULT_PAGE_BYTES = 4 * 1024 * 1024;
export const MAX_PAGE_BYTES = 32 * 1024 * 1024;
// The size at which a LEGACY (unsplit) body is refused rather than materialized. Above this the answer is
// `too_large` and the repair is the split script — see `TrajectoryEventsResult`.
export const MAX_LEGACY_BODY_BYTES = 32 * 1024 * 1024;

// ── A RESOLVED PAGE IS A DIFFERENT SIZE OF PAGE (arch-review 120) ───────────────────────────────────
//
// Every other ceiling here is computed from the STORED bytes, and a resolved read is precisely the read
// whose stored size does not predict its cost: each offloaded field is a preview of at most
// `EVENT_INLINE_MAX` on disk and the whole original in memory. So a 500-event page that clears the 4 MiB
// budget on stored size can materialize gigabytes once resolved — the exact OOM the offload exists to stop,
// re-entered through the flag that undoes it.
//
// Resolving therefore pages in much smaller steps. Nothing is withheld: every reader of resolved events
// (`streamTrajectoryEvents` and the two scoring collectors above it) pages until the cursor is exhausted, so
// a smaller page costs round trips and never events. It lives in `clampWindow` because that is the one owner
// of "what one page means" — a ceiling enforced per caller is a ceiling the next caller widens by asking.
export const MAX_RESOLVED_EVENT_PAGE = 50;

// …and the count is only half of it (arch-review 121). An offloaded event's STORED size is its preview, so
// fifty of them clear every stored-byte budget and can still materialize hundreds of megabytes once the
// objects are fetched. This is the ceiling on what one resolved page may hold in memory; the resolve spends
// it as it builds the page and stops before the event that would exceed it, handing back a cursor. Generous
// on purpose — a judge reading a long trace should page rarely — and finite, which is the property that was
// missing.
export const MAX_RESOLVED_PAGE_BYTES = 32 * 1024 * 1024;

export function clampWindow(window: TrajectoryWindow): { limit: number; maxBytes: number; after: number } {
  const ceiling = window.resolve === true ? MAX_RESOLVED_EVENT_PAGE : MAX_EVENT_PAGE;
  const limit =
    window.limit === undefined || !Number.isFinite(window.limit) || window.limit <= 0
      ? Math.min(DEFAULT_EVENT_PAGE, ceiling)
      : Math.min(Math.floor(window.limit), ceiling);
  const maxBytes =
    window.maxBytes === undefined || !Number.isFinite(window.maxBytes) || window.maxBytes <= 0
      ? DEFAULT_PAGE_BYTES
      : Math.min(Math.floor(window.maxBytes), MAX_PAGE_BYTES);
  const after =
    window.after === undefined || !Number.isFinite(window.after) || window.after < 0 ? 0 : Math.floor(window.after);
  return { limit, maxBytes, after };
}

// ── ONE OWNER FOR "HOW BIG IS THIS", AND IT COUNTS BYTES (arch-review 120) ───────────────────────────
//
// Every ceiling in this file is denominated in BYTES — `MAX_PAGE_BYTES`, the events table's `bytes` column,
// the offload's inline budget. The four places that measured an item all spelled it `JSON.stringify(x).length`,
// which counts UTF-16 CODE UNITS. For ASCII the two agree, which is why it survived; for the traces this
// product is actually sold into they do not:
//
//     a CJK/Hangul character   1 code unit  → 3 bytes      (x3)
//     an emoji                 2 code units → 4 bytes      (x2)
//
// So a 4 MiB page ceiling admitted up to 12 MiB of Korean, and every downstream bound derived from it — the
// HTTP response, the Zod copy, the judge's context — was sized against a number that was not the number of
// bytes. A ceiling that under-counts by 3× on one tenant's data and not another's is worse than a wrong
// ceiling: it is a different product per language.
//
// Exported and consumed by all four sizing sites, because a predicate written twice has already diverged
// (rule `protocol` L3) — and this one had been written four times.
export function serializedBytes(item: unknown): number {
  const text = JSON.stringify(item);
  // `undefined` is not JSON. Nothing sized here should be it, and a thrown TypeError from a caller measuring
  // a page is a worse answer than zero.
  return text === undefined ? 0 : Buffer.byteLength(text, "utf8");
}

// Cut an already-materialized array to one page under both ceilings, using each item's serialized size.
// Shared by the in-memory store and by the LEGACY blob path of the persistent ones, so a legacy plane and a
// split one page identically — the swap is meant to be invisible to a reader, and a second slicing rule is
// how it would stop being.
//
// ⚠️ ALWAYS RETURNS AT LEAST ONE ITEM when there is one. A page that can come back empty because its first
// item alone exceeds the byte budget is a stream that never advances — the caller asks again from the same
// cursor, forever. Bounding one event is the payload offload's job, not the pager's; the pager's job is to
// keep making progress.
export function pageOf<T>(
  items: readonly T[],
  after: number,
  limit: number,
  maxBytes: number,
  sizeOf: (item: T) => number,
): { slice: T[]; nextAfter?: number } {
  const slice: T[] = [];
  let bytes = 0;
  let index = after;
  for (; index < items.length && slice.length < limit; index += 1) {
    const item = items[index];
    if (item === undefined) break;
    const size = sizeOf(item);
    if (slice.length > 0 && bytes + size > maxBytes) break;
    slice.push(item);
    bytes += size;
  }
  return { slice, ...(index < items.length ? { nextAfter: index } : {}) };
}

// ── THE WHOLE STREAM, WITHOUT THE WHOLE STREAM IN MEMORY ─────────────────────────────────────────────
//
// Judges, `spansToEvents`, the sinks and the ingest path legitimately read every event of a plane. They get
// them one page at a time, so peak residency is a page rather than a trajectory — and the Zod copy that used
// to double the whole body is now a copy of a page that is released before the next one arrives.
//
// `too_large` THROWS here rather than ending the iteration, and that is deliberate: a consumer folding this
// stream into a verdict must not be handed a silently short one. A caller that can tolerate partial evidence
// calls `store.events` itself and names what it does with the refusal.
export async function* streamTrajectoryEvents(
  store: Pick<TrajectoryStore, "events">,
  tenant: string,
  runId: string,
  window: Omit<TrajectoryWindow, "after"> = {},
): AsyncGenerator<TraceEvent> {
  let after: number | undefined = 0;
  while (after !== undefined) {
    const result: TrajectoryEventsResult = await store.events(tenant, runId, { ...window, after });
    if (result.kind === "absent") return;
    if (result.kind === "too_large")
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { runId, emitter: result.emitter, storedBytes: result.storedBytes },
        `Trajectory '${runId}' plane '${result.emitter}' is a ${result.storedBytes}-byte legacy body, over the ${result.limitBytes}-byte read ceiling. Split it with scripts/live/split-trajectory-bodies.mjs.`,
      );
    for (const event of result.page.events) yield event;
    after = result.page.nextAfter;
  }
}

// The whole plane as an array, for the callers that genuinely need one — with the collection in ONE place
// rather than re-spelled per consumer, so the memory question has a single owner to revisit.
//
// ⚠️ THIS RETURNS WHAT THE STORE HOLDS, WHICH FOR AN OFFLOADED PAYLOAD IS A PREVIEW. That is right for a
// display: a Files page or a browse row wants the excerpt and the ref. It is wrong for anything that
// DECIDES, and the two used to be one call with an optional flag between them — see
// `collectExactTrajectoryEvents` below, which is what a scorer calls.
// ── AND THE COLLECTOR IS BOUNDED TOO, OR IT REFUSES (arch-review 121) ────────────────────────────────
//
// Every other ceiling on this path became real in this wave: one event is bounded, a stored page is bounded,
// a RESOLVED page is bounded in bytes. This function — the one scoring actually calls — was bounded by
// nothing. It pages politely and pushes every event into one array, so peak heap is the whole trace:
//
//     the read is paged   ≠   the caller holds one page at a time
//
// The pages bound the DATABASE response, never the process. A long-horizon run scored inside the shared
// control plane takes the control plane with it, which is every tenant's outage caused by one case's trace.
//
// Refusing is the honest close, and the alternative is not "score it anyway" — it is "die". One of those is
// attributable to a case and diagnosable; the other is a process nobody can blame. The ceiling is generous
// on purpose: it exists to stop a pathological trace, not to shape ordinary ones.
//
// `streamTrajectoryEvents` above is unchanged and remains the answer for a consumer that folds incrementally.
// The bound belongs on the convenience that MATERIALIZES, not on the stream — which is also why this is not
// an interface change to every grader.
export const MAX_COLLECTED_TRACE_BYTES = 256 * 1024 * 1024;

export async function collectTrajectoryEvents(
  store: Pick<TrajectoryStore, "events">,
  tenant: string,
  runId: string,
  window: Omit<TrajectoryWindow, "after"> = {},
  // Injected only so the counterexample can drive `limit + 1` without materializing a quarter of a gigabyte.
  // A test that must allocate the real ceiling to prove the ceiling exists does not prove it by ASSERTION —
  // it proves it by dying, which is the outcome this bound was added to replace.
  limitBytes: number = MAX_COLLECTED_TRACE_BYTES,
): Promise<TraceEvent[]> {
  const events: TraceEvent[] = [];
  let held = 0;
  for await (const event of streamTrajectoryEvents(store, tenant, runId, window)) {
    held += serializedBytes(event);
    if (held > limitBytes)
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { runId, limitBytes },
        `Trajectory '${runId}' is too large to score in one pass: it exceeds the ${limitBytes}-byte collected-trace ceiling. Read it with streamTrajectoryEvents and fold it, or narrow the window.`,
      );
    events.push(event);
  }
  return events;
}

// ── THE SCORER'S COLLECTOR: EXACT BYTES OR A REFUSAL (arch-review 120) ─────────────────────────────
//
// An offloaded payload's preview is an EXCERPT — `previewOf` keeps a head and drops the rest — so a judge
// handed one under the name of the whole scores different evidence and nothing downstream can tell. The
// offloading store already resolves on demand and already fails closed when the object is missing; what was
// missing is that asking for it was OPTIONAL, spelled `{ resolve: true }`, and one of the two scoring call
// sites did not.
//
// It did not for the reason optional flags always produce: the call reads identically either way. The file
// that owns the offload says "judges, re-scores and ingest are that caller"; the re-score passed the flag
// with a comment saying why, and the owned-trace ingest — six lines under a comment saying "it is scoring
// the trace, not showing it" — did not. Same file, same law, one lane.
//
//     the payload was preserved   ≠   the verdict read the payload
//
// So the guarantee is in the NAME rather than in an argument a caller has to remember. A scoring path calls
// this; if it calls the plain collector instead, that is now visible at the call site rather than absent
// from it.
export async function collectExactTrajectoryEvents(
  store: Pick<TrajectoryStore, "events">,
  tenant: string,
  runId: string,
  window: Omit<TrajectoryWindow, "after" | "resolve"> = {},
  limitBytes: number = MAX_COLLECTED_TRACE_BYTES,
): Promise<TraceEvent[]> {
  return collectTrajectoryEvents(store, tenant, runId, { ...window, resolve: true }, limitBytes);
}
