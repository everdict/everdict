// Auto-update controller — wraps electron-updater via DI (tests inject a fake emitter).
// Policy (design D6, docs/architecture/desktop-app.md): detection and download are automatic, "apply" needs the user's consent (the tray
// restart item) — never force-restart while the runner is running a job. If no feed is configured (disabled), everything is a no-op:
// the feed destination (a public releases repo vs making the repo public) awaits the user's decision — see the gate in main.ts.
export interface AutoUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: string, listener: (...args: never[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export type UpdaterState =
  | { kind: "disabled" } // no feed configured or unpackaged (dev)
  | { kind: "idle" } // active — up to date (or not yet checked)
  | { kind: "checking" }
  | { kind: "downloading"; version: string; percent?: number }
  | { kind: "ready"; version: string } // download complete — applied on restart
  | { kind: "error"; message: string };

export interface UpdaterControllerOpts {
  updater: AutoUpdaterLike | null; // null → disabled
  intervalMs?: number; // re-check interval (default 6 hours)
  onStatus?: (state: UpdaterState) => void;
  log?: (msg: string) => void;
  // Test injection point — defaults to setInterval (+unref). Returns a stop function.
  schedule?: (fn: () => void, ms: number) => () => void;
}

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

export class UpdaterController {
  private current: UpdaterState = { kind: "disabled" };
  private stopSchedule: (() => void) | null = null;
  private started = false;

  constructor(private readonly opts: UpdaterControllerOpts) {}

  state(): UpdaterState {
    return this.current;
  }

  // Wire up events + initial check + periodic re-check. No-op if no feed is configured (stays disabled).
  start(): void {
    const u = this.opts.updater;
    if (!u || this.started) {
      this.emit(this.current);
      return;
    }
    this.started = true;
    u.autoDownload = true; // background download the moment one is detected
    u.autoInstallOnAppQuit = true; // even if the user just quits, the next launch is the new version
    u.on("checking-for-update", () => this.set({ kind: "checking" }));
    u.on("update-available", (info: { version: string }) => this.set({ kind: "downloading", version: info.version }));
    u.on("download-progress", (progress: { percent: number }) => {
      if (this.current.kind === "downloading") this.set({ ...this.current, percent: Math.round(progress.percent) });
    });
    u.on("update-downloaded", (info: { version: string }) => this.set({ kind: "ready", version: info.version }));
    u.on("update-not-available", () => this.set({ kind: "idle" }));
    u.on("error", (err: Error) => {
      // Offline / a transient feed failure is a normal condition — just record the state and retry on the next cycle.
      this.set({ kind: "error", message: err.message });
    });

    const check = () => {
      void u.checkForUpdates().catch((e: unknown) => {
        this.set({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      });
    };
    this.set({ kind: "idle" });
    check();
    const schedule =
      this.opts.schedule ??
      ((fn: () => void, ms: number) => {
        const t = setInterval(fn, ms);
        (t as { unref?: () => void }).unref?.();
        return () => clearInterval(t);
      });
    this.stopSchedule = schedule(check, this.opts.intervalMs ?? SIX_HOURS_MS);
  }

  stop(): void {
    this.stopSchedule?.();
    this.stopSchedule = null;
  }

  // Valid only in the ready state — quit and relaunch into the new version. Cleaning up the runner beforehand is the caller's (main's) responsibility.
  quitAndInstall(): void {
    if (this.current.kind !== "ready") {
      this.opts.log?.("Update is not ready, ignoring quitAndInstall.");
      return;
    }
    this.opts.updater?.quitAndInstall(false, true);
  }

  private set(state: UpdaterState): void {
    this.current = state;
    this.emit(state);
  }

  private emit(state: UpdaterState): void {
    this.opts.onStatus?.(state);
  }
}
