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
  get(runId: string): Promise<CaseRecording | undefined>;
  // The recording as it stands RIGHT NOW, sealed or not — the live tail behind "replay while it runs"
  // (live = a replay that has not finished; the player scrubs back mid-run and pins to the live edge).
  // Unsealed reads derive t0/effectiveFidelity provisionally and report envKind "live" until seal names it.
  peek(runId: string): Promise<CaseRecording | undefined>;
}
