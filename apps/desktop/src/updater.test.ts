import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { type AutoUpdaterLike, UpdaterController, type UpdaterState } from "./updater.js";

// electron-updater 의 최소 표면을 흉내내는 가짜 — 이벤트로 시나리오를 스크립트한다.
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
  it("피드 미구성(null)이면 disabled 로 시작하고 전부 no-op", () => {
    const { states, onStatus } = collect();
    const c = new UpdaterController({ updater: null, onStatus });
    c.start();
    c.quitAndInstall(); // no-op
    expect(c.state()).toEqual({ kind: "disabled" });
    expect(states.at(-1)).toEqual({ kind: "disabled" });
  });

  it("start — autoDownload/autoInstallOnAppQuit 활성 + 즉시 1회 체크 + 주기 재체크 등록", () => {
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
    tick?.(); // 주기 도래 → 재체크
    expect(checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it("checking→available(다운로드)→progress→downloaded(ready) 상태 전이", () => {
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

  it("not-available→idle, error→error(다음 주기에 재시도)", () => {
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

  it("quitAndInstall — ready 에서만 위임(재실행 플래그 포함)", () => {
    const { u, quitAndInstall } = fakeUpdater();
    const c = new UpdaterController({ updater: u, schedule: () => () => {} });
    c.start();
    c.quitAndInstall(); // idle — 무시
    expect(quitAndInstall).not.toHaveBeenCalled();
    u.emit("update-downloaded", { version: "1.2.3" });
    c.quitAndInstall();
    expect(quitAndInstall).toHaveBeenCalledWith(false, true);
  });
});
