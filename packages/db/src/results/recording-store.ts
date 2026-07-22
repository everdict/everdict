import type { RecordingSeal, RecordingStore } from "@everdict/application-control";
import type { CaseRecording, DispatchManifest, Fidelity, RecordingRef, TrackEntry } from "@everdict/contracts";

type SealedMeta = { t0: number; envKind: string; effectiveFidelity: Fidelity; dispatch?: DispatchManifest };

// In-memory recording store (dev/test). Accumulates track entries per runId; `seal` freezes the metadata (deriving
// t0 + effectiveFidelity from the tracks) and hands back a memory:// ref. Interchangeable with the Postgres +
// object-store impl behind RecordingStore (S4).
export class InMemoryRecordingStore implements RecordingStore {
  private readonly recordings = new Map<string, { tracks: CaseRecording["tracks"]; sealed?: SealedMeta }>();

  async append(runId: string, item: TrackEntry): Promise<void> {
    const rec = this.recordings.get(runId) ?? { tracks: {} };
    appendEntry(rec.tracks, item);
    this.recordings.set(runId, rec);
  }

  async seal(runId: string, meta: RecordingSeal): Promise<RecordingRef | undefined> {
    const rec = this.recordings.get(runId);
    if (!rec) return undefined; // nothing was recorded for this run → no ref to attach
    rec.sealed = {
      t0: earliestT(rec.tracks),
      envKind: meta.envKind,
      // What was actually captured: a screen-frame series is `frames`; otherwise only logs/metadata → `final`.
      effectiveFidelity: rec.tracks.frames?.length ? "frames" : "final",
      ...(meta.dispatch ? { dispatch: meta.dispatch } : {}),
    };
    return { ref: `memory://recording/${runId}` };
  }

  async get(runId: string): Promise<CaseRecording | undefined> {
    const rec = this.recordings.get(runId);
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
