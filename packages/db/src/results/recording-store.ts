import { type RecordingSeal, type RecordingStore, recordingRefOf } from "@everdict/application-control";
import type { CaseRecording, DispatchManifest, Fidelity, RecordingRef, TrackEntry } from "@everdict/contracts";

type SealedMeta = { t0: number; envKind: string; effectiveFidelity: Fidelity; dispatch?: DispatchManifest };

// In-memory recording store (dev/test). Accumulates track entries per runId; `seal` freezes the metadata (deriving
// t0 + effectiveFidelity from the tracks) and hands back a memory:// ref. Interchangeable with the Postgres +
// object-store impl behind RecordingStore (S4).
export class InMemoryRecordingStore implements RecordingStore {
  // ONE ROW PER ATTEMPT (review 39, Phase 4). A re-drive opens a new one; the previous attempt's frames stay
  // where they are, because a discarded execution really did happen and deleting its record is not something
  // a ledger does.
  private readonly recordings = new Map<
    string,
    Array<{ tracks: CaseRecording["tracks"]; sealed?: SealedMeta; generation: number }>
  >();

  private attemptsOf(
    runId: string,
  ): Array<{ tracks: CaseRecording["tracks"]; sealed?: SealedMeta; generation: number }> {
    return this.recordings.get(runId) ?? [];
  }

  private attempt(
    runId: string,
    generation: number,
  ): { tracks: CaseRecording["tracks"]; sealed?: SealedMeta; generation: number } | undefined {
    return this.attemptsOf(runId).find((a) => a.generation === generation);
  }

  async open(runId: string): Promise<number> {
    const attempts = this.attemptsOf(runId);
    const generation = Math.max(0, ...attempts.map((a) => a.generation)) + 1;
    this.recordings.set(runId, [...attempts, { tracks: {}, generation }]);
    return generation;
  }

  async append(runId: string, item: TrackEntry, generation: number): Promise<void> {
    // EXACTLY the attempt this producer was told it serves (mig 0173) — its own row, created on first write
    // because a first dispatch opens nothing and its producers stamp 0. What the fence buys is not that a
    // stale producer is silenced (it may keep writing; that is a true record of what it did) but that it
    // writes into ITS OWN attempt, which no reader of the successor's recording is ever served.
    let rec = this.attempt(runId, generation);
    if (!rec) {
      rec = { tracks: {}, generation };
      this.recordings.set(
        runId,
        [...this.attemptsOf(runId), rec].sort((a, b) => a.generation - b.generation),
      );
    }
    // …and a SEALED recording is final (arch-review 38 P0). The self-hosted lane reports frames and logs
    // fire-and-forget, so an append arriving after the settle is ordinary rather than exceptional — and one
    // that lands leaves a recording disagreeing with its own metadata.
    if (rec.sealed) return;
    appendEntry(rec.tracks, item);
  }

  async seal(runId: string, meta: RecordingSeal, generation: number): Promise<RecordingRef | undefined> {
    const rec = this.attempt(runId, generation);
    if (!rec) return undefined; // nothing was recorded for this attempt → no ref to attach
    if (rec.sealed) return undefined; // already frozen — a second seal is not this attempt's to make
    // An EMPTY attempt row seals to nothing — the Pg adapter's own condition (its seal requires the tracks to
    // be non-empty), matched here because every dispatch now OPENS its attempt row up front (review 40): an
    // opened-but-silent attempt must not mint a ref to a replay that holds nothing.
    if (!Object.values(rec.tracks).some((lane) => (lane?.length ?? 0) > 0)) return undefined;
    rec.sealed = {
      t0: earliestT(rec.tracks),
      envKind: meta.envKind,
      // What was actually captured: a screen-frame series is `frames`; otherwise only logs/metadata → `final`.
      effectiveFidelity: rec.tracks.frames?.length ? "frames" : "final",
      ...(meta.dispatch ? { dispatch: meta.dispatch } : {}),
    };
    // The ref NAMES THE ATTEMPT (review 39 P1): a pointer that said only the run could not tell a reader
    // which execution it was about to play.
    return { ref: recordingRefOf("memory", runId, generation) };
  }

  async get(runId: string, generation?: number): Promise<CaseRecording | undefined> {
    const sealed = this.attemptsOf(runId).filter((a) => a.sealed);
    const rec = generation === undefined ? sealed[sealed.length - 1] : sealed.find((a) => a.generation === generation);
    if (!rec?.sealed) return undefined; // only a sealed recording is a complete CaseRecording
    return {
      runId,
      t0: rec.sealed.t0,
      tracks: rec.tracks,
      envKind: rec.sealed.envKind,
      effectiveFidelity: rec.sealed.effectiveFidelity,
      ...(rec.sealed.dispatch ? { dispatch: rec.sealed.dispatch } : {}),
    };
  }

  // The live tail — whatever has streamed in so far, sealed or not (the player scrubs a still-running run with
  // this). Unsealed metadata is provisional: t0/fidelity derived from the tracks, envKind "live" until seal.
  async peek(runId: string, generation?: number): Promise<CaseRecording | undefined> {
    const attempts = this.attemptsOf(runId);
    const rec = generation === undefined ? attempts[attempts.length - 1] : this.attempt(runId, generation);
    if (!rec) return undefined;
    if (rec.sealed) return this.get(runId, rec.generation);
    return {
      runId,
      t0: earliestT(rec.tracks),
      tracks: rec.tracks,
      envKind: "live",
      effectiveFidelity: rec.tracks.frames?.length ? "frames" : "final",
    };
  }
}

// The wall-clock anchor: the earliest event across all lanes (fallback 0 when empty).
function earliestT(tracks: CaseRecording["tracks"]): number {
  let t0 = Number.POSITIVE_INFINITY;
  for (const lane of Object.values(tracks)) {
    if (!lane) continue;
    for (const e of lane) t0 = Math.min(t0, e.t);
  }
  return Number.isFinite(t0) ? t0 : 0;
}

// Push one entry onto its track lane, type-safe over the discriminated TrackEntry (each case narrows item.entry).
function appendEntry(tracks: CaseRecording["tracks"], item: TrackEntry): void {
  switch (item.track) {
    case "frames": {
      const lane = tracks.frames ?? [];
      lane.push(item.entry);
      tracks.frames = lane;
      break;
    }
    case "domEvents": {
      const lane = tracks.domEvents ?? [];
      lane.push(item.entry);
      tracks.domEvents = lane;
      break;
    }
    case "network": {
      const lane = tracks.network ?? [];
      lane.push(item.entry);
      tracks.network = lane;
      break;
    }
    case "console": {
      const lane = tracks.console ?? [];
      lane.push(item.entry);
      tracks.console = lane;
      break;
    }
    case "nav": {
      const lane = tracks.nav ?? [];
      lane.push(item.entry);
      tracks.nav = lane;
      break;
    }
    case "stateDeltas": {
      const lane = tracks.stateDeltas ?? [];
      lane.push(item.entry);
      tracks.stateDeltas = lane;
      break;
    }
    case "logs": {
      const lane = tracks.logs ?? [];
      lane.push(item.entry);
      tracks.logs = lane;
      break;
    }
    case "runtime": {
      const lane = tracks.runtime ?? [];
      lane.push(item.entry);
      tracks.runtime = lane;
      break;
    }
    case "custom": {
      const lane = tracks.custom ?? [];
      lane.push(item.entry);
      tracks.custom = lane;
      break;
    }
  }
}
