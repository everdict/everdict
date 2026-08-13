import type { CaseRecording, DispatchManifest, RecordingRef, TrackEntry } from "@everdict/contracts";

// The metadata seal() needs beyond the accumulated track entries: which recorder's environment kind produced them,
// and the audit manifest. The store derives t0 (earliest event) and effectiveFidelity (what was actually captured).
export interface RecordingSeal {
  envKind: string;
  dispatch?: DispatchManifest;
}

// Durable per-run recording store. Track entries stream in via `append` during the run (mirroring the ephemeral
// live view); `seal` freezes the manifest at finalize and returns a RecordingRef for the record — or undefined when
// nothing was recorded for the run (no ref to attach). In-memory (dev/test) or Postgres + object-store (production),
// swapped behind this interface. docs/architecture/replay.md D4.
export interface RecordingStore {
  append(runId: string, item: TrackEntry): Promise<void>;
  seal(runId: string, meta: RecordingSeal): Promise<RecordingRef | undefined>;
  // A NEW ATTEMPT OPENS A NEW RECORDING (arch-review 33 P1). A re-driven run keeps its live-correlation id —
  // observers derive `evd-run-<id>` from the record with no lookup, which is what makes live observation work
  // — so both attempts append into one buffer, and the winner would otherwise seal a replay containing an
  // execution whose settlement was refused: a reader scrubbing that timeline watches two runs with nothing
  // saying where the seam is.
  //
  // Called by the re-drive itself, which is the one place that knows an attempt is beginning. Deliberately
  // NOT a time-based filter at seal: the lanes carry different clocks (frames and logs are wall-clock, the
  // folded env deltas are trace-relative offsets), so "older than the attempt" is not a question the entries
  // can all answer. "Start again" is.
  //
  // WHAT THIS DOES NOT DO, precisely: a reset removes history, it does not REVOKE a producer. The paused
  // replica whose return is the reason fencing exists at all can wake after the reset and append into the new
  // attempt's buffer, because `append` carries no attempt identity — the self-hosted recorder reports a runId
  // and nothing else. Closing that needs a generation on the wire (`append(runId, generation, item)`), stamped
  // by whichever recorder serves an attempt and refused by the store when it is stale. That is a change to
  // what PRODUCERS say, so it belongs to a change of its own rather than being half-built here with no caller.
  reset(runId: string): Promise<void>;
  get(runId: string): Promise<CaseRecording | undefined>;
  // The recording as it stands RIGHT NOW, sealed or not — the live tail behind "replay while it runs"
  // (live = a replay that has not finished; the player scrubs back mid-run and pins to the live edge).
  // Unsealed reads derive t0/effectiveFidelity provisionally and report envKind "live" until seal names it.
  peek(runId: string): Promise<CaseRecording | undefined>;
}
