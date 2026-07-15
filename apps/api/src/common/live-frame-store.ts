// Latest live-screen frame per run (observability ⑤, self-hosted push path). A self-hosted runner has no channel the
// control plane can reach into mid-run, so for a command harness that declares liveScreen (e.g. browser-use's headless
// Chromium over CDP) the runner captures a frame in the case container and PUSHES it here via the report_case_screen
// MCP tool; RunService.screen() serves the latest frame for that run. In-memory + short TTL (a frame is only useful
// while the run is live), keyed by the CP-minted runId (evd-run-<id> / evd-<batchId>-<caseId>). Single-node only —
// like the WS terminal and lease hub, live viewing does not survive a control-plane restart.
export interface LiveFrame {
  frameBase64: string; // raw base64 PNG (no data: prefix)
  at: number; // capture receipt time (ms) — for TTL expiry
}

export class LiveFrameStore {
  private readonly frames = new Map<string, LiveFrame>();
  constructor(
    private readonly ttlMs = 30_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  // Record the latest frame for a run (overwrites the previous — only the most recent frame matters for live view).
  put(runId: string, frameBase64: string): void {
    this.frames.set(runId, { frameBase64, at: this.now() });
    this.prune();
  }

  // The latest still-fresh frame for a run, or undefined (never pushed / expired). Expired entries are dropped on read.
  get(runId: string): LiveFrame | undefined {
    const f = this.frames.get(runId);
    if (!f) return undefined;
    if (this.now() - f.at > this.ttlMs) {
      this.frames.delete(runId);
      return undefined;
    }
    return f;
  }

  // Drop every entry older than the TTL — bounds the map when runs end without an explicit clear.
  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [k, v] of this.frames) if (v.at < cutoff) this.frames.delete(k);
  }
}
