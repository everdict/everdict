import type { TraceEvent } from "@everdict/contracts";

// Live trajectory per run (observability ⑨ — the trace twin of LiveLogStore). Two producers feed it while a run
// executes: the control plane's own dispatch account (TraceRecordingDispatcher's accepted/waiting/started marks)
// and a self-hosted runner's drained-event batches (report_case_trace). RunService.liveTrace() serves the
// accumulated events for the run detail's live view. In-memory + TTL, keyed by the CP-minted runId
// (evd-run-<id> / evd-<batchId>-<caseId>). Single-node only, like every live store — the SEALED trajectory is
// the durable record; this buffer is a preview and may vanish with a restart without losing anything.
//
// Cumulative like the log store (events append), so the TTL is generous and a per-run ring cap bounds memory —
// a chatty run drops its OLDEST events rather than grow unbounded (the live view is "what is it doing now").
interface LiveTrace {
  events: TraceEvent[];
  // ── WHAT THE RING HAS ALREADY THROWN AWAY (the cursor's other half) ────────────────────────────────
  //
  // A viewer polls this buffer every few seconds, and re-sending the whole ring each time made the CLIENT's
  // cost scale with the run's length rather than with what changed: a five-hour agent's poll re-downloaded
  // 2000 events, re-validated every one through the trace union, and re-rendered the list, three seconds
  // apart, forever.
  //
  // Serving "what is new since X" needs a cursor that survives eviction, and an array index does not — the
  // ring shifts, so index 0 means a different event after every drop. This counts the events the ring has
  // discarded, which makes `dropped + i` an ABSOLUTE position that only ever grows. A client holding an old
  // cursor is then answerable exactly: it is either still inside the window, or it has fallen off the back
  // and is told so rather than silently handed a gap.
  dropped: number;
  at: number; // last-append time (ms) — for TTL expiry
}

// What a polling reader gets: the slice after its cursor, and where to ask from next. `gap` is the honest
// third answer — the reader's cursor is older than the oldest event still buffered, so events it never saw
// have been evicted. It re-renders from `from` instead of appending onto a hole.
export interface LiveTracePage {
  events: TraceEvent[];
  from: number; // absolute position of events[0] (or of the tail, when empty)
  next: number; // the cursor to send on the following poll
  total: number; // absolute count this run has produced, evicted events included
  gap: boolean;
}

export class LiveTraceStore {
  private readonly traces = new Map<string, LiveTrace>();
  constructor(
    private readonly ttlMs = 900_000, // 15 min — kept for the whole (possibly long) run
    private readonly maxEvents = 2000, // ring cap per run
    private readonly now: () => number = () => Date.now(),
  ) {}

  // Append a batch of events to a run's live trajectory (creating the entry on first append).
  append(runId: string, events: TraceEvent[]): void {
    if (events.length === 0) return;
    let entry = this.traces.get(runId);
    if (!entry) {
      entry = { events: [], dropped: 0, at: this.now() };
      this.traces.set(runId, entry);
    }
    entry.events.push(...events);
    if (entry.events.length > this.maxEvents) {
      const excess = entry.events.length - this.maxEvents;
      entry.events.splice(0, excess);
      entry.dropped += excess; // the ring forgets, and the cursor remembers that it did
    }
    entry.at = this.now();
    this.prune();
  }

  // The accumulated events for a run, or undefined (never pushed / expired). Expired entries drop on read.
  get(runId: string): TraceEvent[] | undefined {
    return this.live(runId)?.events;
  }

  // The incremental read: everything after an absolute cursor. `after === undefined` is the first poll and
  // gets the whole window; a cursor from a previous poll gets only what arrived since.
  //
  // A cursor BELOW `dropped` cannot be served as an append — the events between it and the window are gone —
  // so it is answered as a `gap` with the current window, and the reader replaces rather than appends. That
  // is the L2 shape: "we cannot give you what you asked for" is its own answer, not an empty page (which
  // reads as "nothing happened") and not the whole ring pretending to be new.
  page(runId: string, after?: number): LiveTracePage | undefined {
    const e = this.live(runId);
    if (!e) return undefined;
    const total = e.dropped + e.events.length;
    if (after === undefined || after < e.dropped)
      return { events: e.events, from: e.dropped, next: total, total, gap: after !== undefined };
    const start = Math.min(after - e.dropped, e.events.length);
    return { events: e.events.slice(start), from: after, next: total, total, gap: false };
  }

  private live(runId: string): LiveTrace | undefined {
    const e = this.traces.get(runId);
    if (!e) return undefined;
    if (this.now() - e.at > this.ttlMs) {
      this.traces.delete(runId);
      return undefined;
    }
    return e;
  }

  // Drop every entry older than the TTL — bounds the map when runs end without an explicit clear.
  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [k, v] of this.traces) if (v.at < cutoff) this.traces.delete(k);
  }
}
