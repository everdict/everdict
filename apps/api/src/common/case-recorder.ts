import { createHash } from "node:crypto";
import type { ArtifactStore, RecordingStore } from "@everdict/application-control";
import { attemptIdOf } from "@everdict/contracts";
import type { TrackEntry } from "@everdict/contracts";

// The durable twin of LiveFrameStore/LiveLogStore. As a self-hosted runner pushes frames/logs
// (report_case_screen / report_case_log), the runner-lease MCP handlers ALSO tee them here so the run can be
// REPLAYED after it settles: each frame is offloaded to object storage and appended (with a wall-clock stamp) to
// the RecordingStore, and consecutive-identical frames reuse one offloaded object (a still screen is deduped).
// Best-effort throughout — a recording failure must never affect the run. Sealing happens at run finalize
// (RunService), not here. docs/architecture/replay.md D3.
//
// ── THE ATTEMPT IS AN ARGUMENT, NOT A MEMORY (review 39, Phase 4) ────────────────────────────────────
//
// This class used to hold a map of "which attempt I am recording for this run", filled by a `serves()` call
// from whichever code path opened the attempt. That map WAS the fence's authority in practice: a producer in
// another process sent no generation at all, and this process stamped whatever its own map happened to say —
// so a stale attempt's frames were re-labelled as its successor's, and two replicas disagreed about the same
// report depending on which one received it.
//
// The generation now travels with the work (CaseJob.recordingGeneration → the leased job → the authorized
// report), so every caller HAS it and the parameter is required. A recorder that cannot be told which attempt
// it serves is a recorder that must not write, and the type says so.
export class CaseRecorder {
  private readonly lastFrame = new Map<string, { hash: string; ref: string }>();

  constructor(
    private readonly recordings: RecordingStore,
    // Optional: frames need an object store to offload. Without one, logs still record (they carry no bytes).
    private readonly artifacts: ArtifactStore | undefined,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async recordFrame(runId: string, frameBase64: string, generation: number): Promise<void> {
    const artifacts = this.artifacts;
    if (!artifacts) return; // frames need an object store to offload; without one, skip them (logs still record)
    try {
      const t = this.now();
      const hash = createHash("sha256").update(frameBase64).digest("hex");
      // Dedup is per ATTEMPT, not per run (arch-review 47 P1-4): keyed by runId alone, attempt g2's first
      // frame matching g1's last frame reused g1's offloaded object — g2's recording then referenced g1's
      // artifact namespace, breaking both attempt isolation and the retention unit (dropping g1's objects
      // would orphan g2's replay).
      const attemptKey = attemptIdOf(runId, generation);
      const prev = this.lastFrame.get(attemptKey);
      let ref: string;
      if (prev && prev.hash === hash) {
        ref = prev.ref; // consecutive-identical frame → reuse the offloaded object (dedup a static screen)
      } else {
        // …under the ATTEMPT's key (review 39, Phase 4). `recordings/<runId>/…` is one namespace for every
        // execution of a run, and an object store has no compare-and-set: two attempts writing a frame at the
        // same millisecond would leave one's bytes under the other's reference.
        ref = await artifacts.put(
          `attempts/${attemptIdOf(runId, generation)}/frames/${t}.png`,
          Buffer.from(frameBase64, "base64"),
          "image/png",
        );
        this.lastFrame.set(attemptKey, { hash, ref });
      }
      await this.recordings.append(runId, { track: "frames", entry: { t, ref, hash } }, generation);
    } catch {
      // best-effort — a recording failure must never affect the run
    }
  }

  async recordLog(runId: string, line: string, generation: number): Promise<void> {
    try {
      await this.recordings.append(
        runId,
        { track: "logs", entry: { t: this.now(), stream: "stdout", text: line } },
        generation,
      );
    } catch {
      // best-effort
    }
  }

  // Append a pre-prepared deep-capture entry (network/console/nav/dom/stateDeltas/runtime/custom). Byte-heavy
  // entries (dom-event batches) carry an object-store ref the PRODUCER already offloaded, so this is a pure
  // append — the deep-track twin of recordFrame (which offloads a raw frame). Frames still go through recordFrame.
  async recordTrack(runId: string, item: TrackEntry, generation: number): Promise<void> {
    try {
      await this.recordings.append(runId, item, generation);
    } catch {
      // best-effort — a recording failure must never affect the run
    }
  }
}
