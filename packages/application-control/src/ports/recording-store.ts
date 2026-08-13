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
  // `generation` is the ATTEMPT this producer is serving (mig 0173) — REQUIRED, and the first attempt says 0
  // rather than saying nothing (arch-review 37 P0). It was optional for one review, and optional is how the
  // fence became decorative: the store let a missing generation through, and the producer that actually
  // matters — the FIRST attempt's recorder, the one that pauses and comes back — had never been told a
  // number, so it sent none and was waved past. A guarantee with a hole shaped like its most common caller
  // is not a guarantee. An append whose generation is not the row's current one is DROPPED.
  append(runId: string, item: TrackEntry, generation: number): Promise<void>;
  // …and the SEAL proves it too: refusing a stale producer's appends while letting it freeze the buffer
  // would fence the writing and not the publishing.
  seal(runId: string, meta: RecordingSeal, generation: number): Promise<RecordingRef | undefined>;
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
  // …and it RAISES the generation, which is the half that revokes rather than erases: the previous attempt's
  // recorder keeps writing under the number it was started with, and those appends are refused. The returned
  // value is what the new attempt's producers stamp.
  reset(runId: string): Promise<number>;
  get(runId: string): Promise<CaseRecording | undefined>;
  // The recording as it stands RIGHT NOW, sealed or not — the live tail behind "replay while it runs"
  // (live = a replay that has not finished; the player scrubs back mid-run and pins to the live edge).
  // Unsealed reads derive t0/effectiveFidelity provisionally and report envKind "live" until seal names it.
  peek(runId: string): Promise<CaseRecording | undefined>;
}
