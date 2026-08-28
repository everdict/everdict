import type { TraceEvent } from "@everdict/contracts";
import { previewFromEvents, spansToEvents } from "@everdict/domain";
import type {
  SealInput,
  SealedTrajectory,
  TrajectoryListResult,
  TrajectoryMeta,
  TrajectoryStore,
  TrajectoryUsage,
} from "./trajectory-store.js";

// Every sealed trajectory gets a line naming what it was asked to do — derived ONCE, here.
//
// The browse ledger's handle (`TrajectoryMeta.label`) names the run's HARNESS, and for an agent run the
// harness IS the agent — so one agent answering twenty questions seals twenty rows that all read
// `default <uuid>`. The distinguishing thing is the work, and the work is inside the body the seal already
// carries, so this decorator reads it there (`previewFromEvents`, @everdict/domain — the same derivation the
// platform trace adapters use, so our own list and a pulled platform list cannot answer differently).
//
// A DECORATOR rather than a stamp at each call site, for the reason the events rule gives: emit where the
// state changes ONCE. There are eight seal paths (run settle, front-door turn, session task, sandbox close,
// judge, scorecard ingest, the OTLP door, `sealExecutionPlanes`) and only some of them have a run record to
// name the row from — the door's arrivals and materialized imports have none at all. Wrapping the store names
// all of them, including the ones nobody would have remembered to touch.
//
// Never overwrites: a caller that supplies its own preview knows something the body does not say.
export class NamingTrajectoryStore implements TrajectoryStore {
  constructor(private readonly inner: TrajectoryStore) {}

  async seal(input: SealInput): Promise<TrajectoryMeta & { created: boolean }> {
    if (input.preview !== undefined) return this.inner.seal(input);
    const preview = previewFromEvents(eventsOf(input));
    return this.inner.seal(preview === undefined ? input : { ...input, preview });
  }

  // Forwarded with its options for the reason the list below states: a decorator that drops the identity
  // silently turns an exact-identity read back into the clock-resolved one, which is the defect, not a
  // degradation of it.
  get(tenant: string, runId: string, opts?: { attemptId: string }): Promise<SealedTrajectory | undefined> {
    return this.inner.get(tenant, runId, opts);
  }

  // Explicitly forwarded field by field rather than spread: the port's own comment says a decorator that
  // destructures the options drops a filter silently, and a dropped `kind` reads as "nothing of this kind
  // exists" rather than as a bug.
  list(
    tenant: string,
    opts?: { limit?: number; cursor?: string; viewer?: string; kind?: string },
  ): Promise<TrajectoryListResult> {
    return this.inner.list(tenant, opts);
  }

  usage(tenant: string, runId: string): Promise<TrajectoryUsage> {
    return this.inner.usage(tenant, runId);
  }

  ingestedSince(tenant: string, sinceIso: string): Promise<{ trajectories: number; events: number }> {
    return this.inner.ingestedSince(tenant, sinceIso);
  }

  deleteOlderThan(cutoffIso: string): Promise<number> {
    return this.inner.deleteOlderThan(cutoffIso);
  }
}

// The events to read the line from. A `spans` body is the record (N6) — project it the same way the store
// does on read, so a span-sealed trajectory is named exactly as its event-sealed twin would be. A malformed
// body must never fail a seal: naming is a courtesy to the reader, evidence retention is the contract.
function eventsOf(input: SealInput): TraceEvent[] {
  if (input.events !== undefined) return input.events;
  if (input.spans === undefined) return [];
  try {
    return spansToEvents(input.spans);
  } catch {
    return [];
  }
}
