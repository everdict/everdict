import {
  BadRequestError,
  type ComputeHandle,
  type EnvSpec,
  type Environment,
  type OsUseSnapshot,
} from "@everdict/core";

const DEFAULT_DISPLAY = ":99";
const DEFAULT_SHOT = "/tmp/everdict-screen.png";

// Desktop (OS) computer-use environment — the agent looks at the screen and manipulates GUI apps (OSWorld-style, e.g. hermes-desktop).
// Runs inside a desktop compute image (Xvfb + apps): seed runs setup (starting the display/wm/apps), snapshot captures a screenshot.
// snapshot(compute) can't receive the spec, so it keeps the display/screenshot config received in seed on the instance and uses it.
export class OsUseEnvironment implements Environment<OsUseSnapshot> {
  readonly kind = "os-use" as const;
  private display = DEFAULT_DISPLAY;
  private shotPath = DEFAULT_SHOT;
  private shotCmd = `scrot -o ${DEFAULT_SHOT}`;

  async seed(compute: ComputeHandle, spec: EnvSpec): Promise<void> {
    if (spec.kind !== "os-use") throw new BadRequestError("BAD_REQUEST", { kind: spec.kind });
    this.display = spec.display ?? DEFAULT_DISPLAY;
    this.shotPath = spec.screenshotPath ?? DEFAULT_SHOT;
    this.shotCmd = spec.screenshotCmd ?? `scrot -o ${this.shotPath}`;
    // Start the display/window manager/desktop apps (background daemons via & in the setup commands). Inject DISPLAY.
    for (const cmd of spec.setup ?? []) {
      await compute.exec(cmd, { env: { DISPLAY: this.display }, timeoutSec: 180 });
    }
  }

  async snapshot(compute: ComputeHandle): Promise<OsUseSnapshot> {
    await compute.exec(this.shotCmd, { env: { DISPLAY: this.display }, timeoutSec: 60 });
    // Embed the screenshot PNG as base64 (compute is disposed → carry it out of the result). best-effort: empty string on failure.
    const shot = await compute.exec(`base64 -w0 '${this.shotPath.replace(/'/g, "'\\''")}'`, { timeoutSec: 60 });
    const screenshot = shot.exitCode === 0 ? shot.stdout.trim() : "";
    // Visible window titles (best-effort: if wmctrl exists). Empty list otherwise — the primary signal is the screenshot.
    const w = await compute.exec("wmctrl -l 2>/dev/null | sed 's/^[^ ]* *[^ ]* *[^ ]* //' || true", {
      env: { DISPLAY: this.display },
    });
    const windows = w.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    return { kind: "os-use", screenshotRef: this.shotPath, screenshot, windows };
  }
}
