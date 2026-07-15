import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { type AutoUpdaterLike, UpdaterController, type UpdaterState } from "./updater.js";

// A fake that mimics the minimal surface of electron-updater — scripts scenarios via events.
function fakeUpdater() {
  const emitter = new EventEmitter();
  const checkForUpdates = vi.fn(async () => ({}));
  const quitAndInstall = vi.fn();
  const u: AutoUpdaterLike & { emit: (ev: string, ...args: unknown[]) => void } = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    on: (ev, l) => emitter.on(ev, l as (...args: unknown[]) => void),
    checkForUpdates,
    quitAndInstall,
    emit: (ev, ...args) => emitter.emit(ev, ...args),
  };
  return { u, checkForUpdates, quitAndInstall };
}

function collect(): { states: UpdaterState[]; onStatus: (s: UpdaterState) => void } {
  const states: UpdaterState[] = [];
  return { states, onStatus: (s) => states.push(s) };
}

describe("UpdaterController", () => {
  it("with no feed configured (null), starts disabled and everything is a no-op", () => {
    const { states, onStatus } = collect();
    const c = new UpdaterController({ updater: null, onStatus });
    c.start();
    c.quitAndInstall(); // no-op
    expect(c.state()).toEqual({ kind: "disabled" });
    expect(states.at(-1)).toEqual({ kind: "disabled" });
  });

  it("start — enables autoDownload/autoInstallOnAppQuit + one immediate check + registers a periodic re-check", () => {
    const { u, checkForUpdates } = fakeUpdater();
    const scheduled: Array<{ ms: number }> = [];
    let tick: (() => void) | undefined;
    const c = new UpdaterController({
      updater: u,
      intervalMs: 1234,
      schedule: (fn, ms) => {
        scheduled.push({ ms });
        tick = fn;
        return () => {};
      },
    });
    c.start();
    expect(u.autoDownload).toBe(true);
    expect(u.autoInstallOnAppQuit).toBe(true);
    expect(checkForUpdates).toHaveBeenCalledTimes(1);
    expect(scheduled).toEqual([{ ms: 1234 }]);
    tick?.(); // interval elapsed → re-check
    expect(checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it("state transitions checking→available(downloading)→progress→downloaded(ready)", () => {
    const { u } = fakeUpdater();
    const { states, onStatus } = collect();
    const c = new UpdaterController({ updater: u, onStatus, schedule: () => () => {} });
    c.start();
    u.emit("checking-for-update");
    u.emit("update-available", { version: "9.9.9" });
    u.emit("download-progress", { percent: 41.7 });
    u.emit("update-downloaded", { version: "9.9.9" });
    expect(states.map((s) => s.kind)).toContain("checking");
    expect(states).toContainEqual({ kind: "downloading", version: "9.9.9", percent: 42 });
    expect(c.state()).toEqual({ kind: "ready", version: "9.9.9" });
  });

  it("autoDownload=false (deb/rpm) — onAvailable fires but there is no downloading/ready (detect-only)", () => {
    const { u } = fakeUpdater();
    const { states, onStatus } = collect();
    const seen: string[] = [];
    const c = new UpdaterController({
      updater: u,
      onStatus,
      autoDownload: false,
      onAvailable: (v) => seen.push(v),
      schedule: () => () => {},
    });
    c.start();
    expect(u.autoDownload).toBe(false);
    u.emit("update-available", { version: "9.9.9" });
    expect(seen).toEqual(["9.9.9"]); // caller gets the detect signal (→ manual-download prompt)
    expect(states.map((s) => s.kind)).not.toContain("downloading"); // no in-place download attempted
    expect(c.state()).toEqual({ kind: "idle" });
  });

  it("autoDownload=true — onAvailable still fires alongside the downloading transition", () => {
    const { u } = fakeUpdater();
    const seen: string[] = [];
    const c = new UpdaterController({ updater: u, onAvailable: (v) => seen.push(v), schedule: () => () => {} });
    c.start();
    u.emit("update-available", { version: "2.0.0" });
    expect(seen).toEqual(["2.0.0"]);
    expect(c.state()).toEqual({ kind: "downloading", version: "2.0.0" });
  });

  it("not-available→idle, error→error (retries on the next cycle)", () => {
    const { u, checkForUpdates } = fakeUpdater();
    let tick: (() => void) | undefined;
    const c = new UpdaterController({
      updater: u,
      schedule: (fn) => {
        tick = fn;
        return () => {};
      },
    });
    c.start();
    u.emit("update-not-available");
    expect(c.state()).toEqual({ kind: "idle" });
    u.emit("error", new Error("feed unreachable"));
    expect(c.state()).toEqual({ kind: "error", message: "feed unreachable" });
    tick?.();
    expect(checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it("quitAndInstall — delegates only from ready (with the relaunch flag)", () => {
    const { u, quitAndInstall } = fakeUpdater();
    const c = new UpdaterController({ updater: u, schedule: () => () => {} });
    c.start();
    c.quitAndInstall(); // idle — ignored
    expect(quitAndInstall).not.toHaveBeenCalled();
    u.emit("update-downloaded", { version: "1.2.3" });
    c.quitAndInstall();
    expect(quitAndInstall).toHaveBeenCalledWith(false, true);
  });
});
