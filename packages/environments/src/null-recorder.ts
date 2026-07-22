import type { EnvironmentRecorder, RecorderCapabilities } from "@everdict/contracts";

// The prompt environment has no world to record beyond the trace — a no-op recorder. Its ceiling is `final`, so any
// higher requested fidelity clamps down visibly (never a phantom empty frame/DOM track). docs/architecture/replay.md.
export class NullRecorder implements EnvironmentRecorder {
  capabilities(): RecorderCapabilities {
    return { maxFidelity: "final", tracks: [] };
  }
  async start(): Promise<void> {}
  async checkpoint(): Promise<void> {}
  async stop(): Promise<void> {}
}
