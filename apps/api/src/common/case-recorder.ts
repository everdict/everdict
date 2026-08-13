import { createHash } from "node:crypto";
import type { ArtifactStore, RecordingStore } from "@everdict/application-control";
import type { TrackEntry } from "@everdict/contracts";

// The durable twin of LiveFrameStore/LiveLogStore. As a self-hosted runner pushes frames/logs
// (report_case_screen / report_case_log), the runner-lease MCP handlers ALSO tee them here so the run can be
// REPLAYED after it settles: each frame is offloaded to object storage and appended (with a wall-clock stamp) to
// the RecordingStore, and consecutive-identical frames reuse one offloaded object (a still screen is deduped).
// Best-effort throughout — a recording failure must never affect the run. Sealing happens at run finalize
// (RunService), not here. docs/architecture/replay.md D3.
export class CaseRecorder {
  private readonly lastFrame = new Map<string, { hash: string; ref: string }>();
  // WHICH ATTEMPT THIS PROCESS IS RECORDING (mig 0173). A re-driven run keeps its correlation id — that is
  // what lets an observer find it without a lookup — so two attempts write into one buffer, and clearing the
  // buffer on re-drive removes history without revoking the recorder that has not noticed it was replaced.
  // The generation is stamped on every append, and the store refuses one from an earlier attempt.
  //
  // Unset for a run this process was never told about (the ordinary first attempt): the append carries no
  // generation and is accepted, exactly as it always was.
  private readonly attempt = new Map<string, number>();

  // The re-drive tells the recorder which attempt it is now serving; the value comes from the reset that
  // began it, so a recorder cannot invent one.
  serves(runId: string, generation: number): void {
    this.attempt.set(runId, generation);
  }
  constructor(
    private readonly recordings: RecordingStore,
    // Optional: frames need an object store to offload. Without one, logs still record (they carry no bytes).
    private readonly artifacts: ArtifactStore | undefined,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async recordFrame(runId: string, frameBase64: string): Promise<void> {
    const artifacts = this.artifacts;
    if (!artifacts) return; // frames need an object store to offload; without one, skip them (logs still record)
    try {
      const t = this.now();
      const hash = createHash("sha256").update(frameBase64).digest("hex");
      const prev = this.lastFrame.get(runId);
      let ref: string;
      if (prev && prev.hash === hash) {
        ref = prev.ref; // consecutive-identical frame → reuse the offloaded object (dedup a static screen)
      } else {
        ref = await artifacts.put(`recordings/${runId}/${t}.png`, Buffer.from(frameBase64, "base64"), "image/png");
        this.lastFrame.set(runId, { hash, ref });
      }
      await this.recordings.append(runId, { track: "frames", entry: { t, ref, hash } }, this.attempt.get(runId));
    } catch {
      // best-effort — a recording failure must never affect the run
    }
  }

  async recordLog(runId: string, line: string): Promise<void> {
    try {
      await this.recordings.append(
        runId,
        { track: "logs", entry: { t: this.now(), stream: "stdout", text: line } },
        this.attempt.get(runId),
      );
    } catch {
      // best-effort
    }
  }

  // Append a pre-prepared deep-capture entry (network/console/nav/dom/stateDeltas/runtime/custom). Byte-heavy
  // entries (dom-event batches) carry an object-store ref the PRODUCER already offloaded, so this is a pure
  // append — the deep-track twin of recordFrame (which offloads a raw frame). Frames still go through recordFrame.
  async recordTrack(runId: string, item: TrackEntry): Promise<void> {
    try {
      await this.recordings.append(runId, item, this.attempt.get(runId));
    } catch {
      // best-effort — a recording failure must never affect the run
    }
  }
}
