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
  // ── AN ATTEMPT IS A ROW, NOT A RESET (review 39, Phase 4) ────────────────────────────────────────
  //
  // `reset` cleared the buffer and raised the generation, which revoked the previous producer correctly and
  // ERASED what it had already written. Two things were wrong with that. Evidence is not ours to delete: the
  // discarded attempt really did run, and its frames are the only record of what happened during it. And a
  // recording addressed by run id alone could not answer "which execution is this a replay of" — the
  // question a reader holding a verdict actually has.
  //
  // Opening an attempt now INSERTS one. Older attempts stay where they are, addressable by their own
  // generation, and a reader that asks for none gets the newest sealed one — the run's current replay.
  // Returns the generation this attempt owns; every producer stamps it (CaseJob.recordingGeneration).
  open(runId: string): Promise<number>;
  // The recording of ONE attempt, or — with no generation — the newest sealed one. A run's replay is its
  // latest completed attempt; naming a generation is how a historical reader pins the one it means.
  get(runId: string, generation?: number): Promise<CaseRecording | undefined>;
  // The recording as it stands RIGHT NOW, sealed or not — the live tail behind "replay while it runs"
  // (live = a replay that has not finished; the player scrubs back mid-run and pins to the live edge).
  // Unsealed reads derive t0/effectiveFidelity provisionally and report envKind "live" until seal names it.
  peek(runId: string, generation?: number): Promise<CaseRecording | undefined>;
}

// ── THE REF NAMES THE ATTEMPT, IN ONE SPELLING ────────────────────────────────────────────────────
//
// Both stores mint `<scheme>://recording/<runId>/g<n>`, and the reader that resolves a settled run's replay
// parses the same string back. Deriving it twice is how the attempt id split into two axes nobody could
// join in the first place, so the grammar lives once, next to the port both sides implement.
export function recordingRefOf(scheme: "memory" | "pg", runId: string, generation: number): string {
  return `${scheme}://recording/${runId}/g${generation}`;
}

// The attempt a stored ref points at, or undefined when it names none — every ref written before this
// grammar existed, which reads as "the producer did not say" and never as agreement with the newest attempt.
export function recordingGenerationOf(ref: string): number | undefined {
  const match = /\/g(\d+)$/.exec(ref);
  if (!match?.[1]) return undefined;
  return Number(match[1]);
}
