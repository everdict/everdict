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
  at: number; // last-append time (ms) — for TTL expiry
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
      entry = { events: [], at: this.now() };
      this.traces.set(runId, entry);
    }
    entry.events.push(...events);
    if (entry.events.length > this.maxEvents) entry.events.splice(0, entry.events.length - this.maxEvents);
    entry.at = this.now();
    this.prune();
  }

  // The accumulated events for a run, or undefined (never pushed / expired). Expired entries drop on read.
  get(runId: string): TraceEvent[] | undefined {
    const e = this.traces.get(runId);
    if (!e) return undefined;
    if (this.now() - e.at > this.ttlMs) {
      this.traces.delete(runId);
      return undefined;
    }
    return e.events;
  }

  // Drop every entry older than the TTL — bounds the map when runs end without an explicit clear.
  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [k, v] of this.traces) if (v.at < cutoff) this.traces.delete(k);
  }
}
