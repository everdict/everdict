import { createHash } from "node:crypto";
import type { ArtifactStore, RecordingStore } from "@everdict/application-control";

// The durable twin of LiveFrameStore/LiveLogStore. As a self-hosted runner pushes frames/logs
// (report_case_screen / report_case_log), the runner-lease MCP handlers ALSO tee them here so the run can be
// REPLAYED after it settles: each frame is offloaded to object storage and appended (with a wall-clock stamp) to
// the RecordingStore, and consecutive-identical frames reuse one offloaded object (a still screen is deduped).
// Best-effort throughout — a recording failure must never affect the run. Sealing happens at run finalize
// (RunService), not here. docs/architecture/replay.md D3.
export class CaseRecorder {
  private readonly lastFrame = new Map<string, { hash: string; ref: string }>();
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
      await this.recordings.append(runId, { track: "frames", entry: { t, ref, hash } });
    } catch {
      // best-effort — a recording failure must never affect the run
    }
  }

  async recordLog(runId: string, line: string): Promise<void> {
    try {
      await this.recordings.append(runId, { track: "logs", entry: { t: this.now(), stream: "stdout", text: line } });
    } catch {
      // best-effort
    }
  }
}
