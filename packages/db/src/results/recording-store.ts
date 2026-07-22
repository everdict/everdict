import type { RecordingSeal, RecordingStore } from "@everdict/application-control";
import type { CaseRecording, RecordingRef, TrackEntry } from "@everdict/contracts";

// In-memory recording store (dev/test). Accumulates track entries per runId; `seal` freezes the metadata and hands
// back a memory:// ref. Interchangeable with the Postgres + object-store impl behind RecordingStore (S4).
export class InMemoryRecordingStore implements RecordingStore {
  private readonly recordings = new Map<string, { tracks: CaseRecording["tracks"]; sealed?: RecordingSeal }>();

  async append(runId: string, item: TrackEntry): Promise<void> {
    const rec = this.recordings.get(runId) ?? { tracks: {} };
    appendEntry(rec.tracks, item);
    this.recordings.set(runId, rec);
  }

  async seal(runId: string, meta: RecordingSeal): Promise<RecordingRef> {
    const rec = this.recordings.get(runId) ?? { tracks: {} };
    rec.sealed = meta;
    this.recordings.set(runId, rec);
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
      dispatch: rec.sealed.dispatch,
    };
  }
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
