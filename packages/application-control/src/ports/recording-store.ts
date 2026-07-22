import type { CaseRecording, DispatchManifest, Fidelity, RecordingRef, TrackEntry } from "@everdict/contracts";

// The metadata seal() needs beyond the accumulated track entries — the recording's clock anchor, which recorder
// produced it, what fidelity was actually captured (clamped), and the audit manifest.
export interface RecordingSeal {
  t0: number;
  envKind: string;
  effectiveFidelity: Fidelity;
  dispatch?: DispatchManifest;
}

// Durable per-run recording store. Track entries stream in via `append` during the run (mirroring the ephemeral
// live view); `seal` freezes the manifest at finalize and returns a RecordingRef for the record. In-memory
// (dev/test) or Postgres + object-store (production), swapped behind this interface. docs/architecture/replay.md D4.
export interface RecordingStore {
  append(runId: string, item: TrackEntry): Promise<void>;
  seal(runId: string, meta: RecordingSeal): Promise<RecordingRef>;
  get(runId: string): Promise<CaseRecording | undefined>;
}
