import { describe, expect, it, vi } from "vitest";
import type { DesktopRunnerStatus, DesktopRunnersStatus, IpcMainLike } from "./bridge.js";
import type { TrayMenuState } from "./tray-menu.js";
import {
  TRAY_CHANNELS,
  TrayActionSchema,
  type TrayBridgeDeps,
  aggregateRunnerState,
  buildTrayPopoverViewModel,
  popoverPosition,
  registerTrayBridge,
} from "./tray-popover.js";
import type { UpdaterState } from "./updater.js";

const runner = (over: Partial<DesktopRunnerStatus> = {}): DesktopRunnerStatus => ({
  paired: true,
  runnerId: "r1",
  state: "idle",
  activeJobs: 0,
  capabilities: ["repo"],
  ...over,
});
const OFF: DesktopRunnersStatus = { runners: [] };
const IDLE: DesktopRunnersStatus = { runners: [runner()] };
const BUSY: DesktopRunnersStatus = { runners: [runner({ state: "running", activeJobs: 2 })] };
const NO_UPDATE: UpdaterState = { kind: "disabled" };
const state = (over: Partial<TrayMenuState> = {}): TrayMenuState => ({
  autostart: false,
  runner: OFF,
  updater: NO_UPDATE,
  ...over,
});

describe("aggregateRunnerState", () => {
  it("is off with no online runner, idle when online, running when a job is in flight", () => {
    expect(aggregateRunnerState(OFF)).toBe("off");
    expect(aggregateRunnerState({ runners: [runner({ state: "off" })] })).toBe("off");
    expect(aggregateRunnerState(IDLE)).toBe("idle");
    expect(aggregateRunnerState(BUSY)).toBe("running");
  });

  it("is running if any runner in the pool is working, even when others are idle", () => {
    const pool: DesktopRunnersStatus = {
      runners: [runner({ runnerId: "r1", state: "idle" }), runner({ runnerId: "r2", state: "running", activeJobs: 1 })],
    };
    expect(aggregateRunnerState(pool)).toBe("running");
  });
});

describe("buildTrayPopoverViewModel", () => {
  it("precomputes label/state/autostart and hides unpair when there is no runner", () => {
    const vm = buildTrayPopoverViewModel(state({ autostart: true, runner: OFF }));
    expect(vm.runnerState).toBe("off");
    expect(vm.autostart).toBe(true);
    expect(vm.canUnpair).toBe(false);
    expect(vm.activeJobs).toBe(0);
    expect(vm.update).toEqual({ kind: "none" });
  });

  it("phrases the unpair label singular vs plural (matching the native menu)", () => {
    expect(buildTrayPopoverViewModel(state({ runner: IDLE })).unpairLabel).toBe("Unpair this device's runner");
    const pool: DesktopRunnersStatus = { runners: [runner({ runnerId: "r1" }), runner({ runnerId: "r2" })] };
    expect(buildTrayPopoverViewModel(state({ runner: pool })).unpairLabel).toBe("Unpair all runners on this device");
  });

  it("offers reconnect only when paired, phrased singular vs plural (matching the native menu)", () => {
    expect(buildTrayPopoverViewModel(state({ runner: OFF })).canReconnect).toBe(false);
    expect(buildTrayPopoverViewModel(state({ runner: IDLE })).reconnectLabel).toBe("Reconnect this device's runner");
    const pool: DesktopRunnersStatus = { runners: [runner({ runnerId: "r1" }), runner({ runnerId: "r2" })] };
    const vm = buildTrayPopoverViewModel(state({ runner: pool }));
    expect(vm.canReconnect).toBe(true);
    expect(vm.reconnectLabel).toBe("Reconnect all runners on this device");
  });

  it("sums active jobs and reflects the running state", () => {
    const vm = buildTrayPopoverViewModel(state({ runner: BUSY }));
    expect(vm.runnerState).toBe("running");
    expect(vm.activeJobs).toBe(2);
    expect(vm.canUnpair).toBe(true);
  });

  it("maps the updater to a downloading (with percent) / ready view; other kinds collapse to none", () => {
    expect(
      buildTrayPopoverViewModel(state({ updater: { kind: "downloading", version: "9.9.9", percent: 42 } })).update,
    ).toEqual({
      kind: "downloading",
      label: "Downloading update… (42%)",
      percent: 42,
    });
    expect(buildTrayPopoverViewModel(state({ updater: { kind: "downloading", version: "9.9.9" } })).update).toEqual({
      kind: "downloading",
      label: "Downloading update…",
    });
    expect(buildTrayPopoverViewModel(state({ updater: { kind: "ready", version: "9.9.9" } })).update).toEqual({
      kind: "ready",
      version: "9.9.9",
      label: "Apply update v9.9.9",
    });
    expect(buildTrayPopoverViewModel(state({ updater: { kind: "checking" } })).update).toEqual({ kind: "none" });
  });
});

describe("popoverPosition", () => {
  const workArea = { x: 0, y: 0, width: 1440, height: 900 };
  const size = { width: 288, height: 232 };

  it("drops below a top-edge tray (menu bar) and centers x on the icon", () => {
    const tray = { x: 1200, y: 0, width: 24, height: 24 };
    const { x, y } = popoverPosition({ tray, size, workArea });
    expect(y).toBe(24 + 6); // below the icon + gap
    expect(x).toBe(1212 - 144); // tray center (1212) - half the popover width
  });

  it("rises above a bottom-edge tray (taskbar)", () => {
    const tray = { x: 1300, y: 876, width: 24, height: 24 };
    const { y } = popoverPosition({ tray, size, workArea });
    expect(y).toBe(876 - size.height - 6); // above the icon - gap
  });

  it("clamps x so the popover never leaves the work area", () => {
    const tray = { x: 1430, y: 0, width: 20, height: 20 };
    const { x } = popoverPosition({ tray, size, workArea });
    expect(x).toBe(workArea.width - size.width); // right edge, not off-screen
    expect(x).toBeGreaterThanOrEqual(0);
  });

  it("falls back to the top-right corner when the tray reports no geometry (Linux AppIndicator)", () => {
    const { x, y } = popoverPosition({ tray: { x: 0, y: 0, width: 0, height: 0 }, size, workArea });
    expect(x).toBe(workArea.width - size.width - 6);
    expect(y).toBe(6);
  });

  it("respects a non-zero work-area origin (secondary display / offset panels)", () => {
    const offset = { x: 1440, y: 30, width: 1440, height: 870 };
    const { x, y } = popoverPosition({ tray: { x: 0, y: 0, width: 0, height: 0 }, size, workArea: offset });
    expect(x).toBe(1440 + 1440 - size.width - 6);
    expect(y).toBe(30 + 6);
  });
});

describe("TrayActionSchema", () => {
  it("accepts the known actions and requires a boolean value for setAutostart", () => {
    expect(TrayActionSchema.parse({ type: "openApp" })).toEqual({ type: "openApp" });
    expect(TrayActionSchema.parse({ type: "setAutostart", value: true })).toEqual({
      type: "setAutostart",
      value: true,
    });
    expect(() => TrayActionSchema.parse({ type: "setAutostart" })).toThrow();
    expect(() => TrayActionSchema.parse({ type: "nope" })).toThrow();
    expect(TrayActionSchema.parse({ type: "reconnect" })).toEqual({ type: "reconnect" });
  });
});

// A tiny fake ipcMain that records the registered handlers by channel.
function fakeIpc(): {
  handlers: Map<string, (event: { senderFrame: { url: string } | null }, payload: unknown) => unknown>;
} & IpcMainLike {
  const handlers = new Map<string, (event: { senderFrame: { url: string } | null }, payload: unknown) => unknown>();
  return { handlers, handle: (channel, listener) => void handlers.set(channel, listener) };
}

const TRAY_URL = "file:///app/assets/tray-popover.html";
const fromTray = { senderFrame: { url: TRAY_URL } };
const notTray = { senderFrame: { url: "https://evil.example" } };

function deps(over: Partial<TrayBridgeDeps> = {}): TrayBridgeDeps {
  return {
    fromTrayPage: (url) => url === TRAY_URL,
    getState: () => state({ runner: IDLE }),
    performAction: vi.fn(),
    setContentHeight: vi.fn(),
    hide: vi.fn(),
    ...over,
  };
}

describe("registerTrayBridge", () => {
  it("returns the view model for the state channel from the trusted frame", () => {
    const ipc = fakeIpc();
    registerTrayBridge(ipc, deps());
    const vm = ipc.handlers.get(TRAY_CHANNELS.state)?.(fromTray, undefined);
    expect(vm).toMatchObject({ runnerState: "idle", canUnpair: true });
  });

  it("rejects every call whose frame is not the popover page", () => {
    const ipc = fakeIpc();
    const d = deps();
    registerTrayBridge(ipc, d);
    for (const ch of [TRAY_CHANNELS.state, TRAY_CHANNELS.action, TRAY_CHANNELS.resize, TRAY_CHANNELS.hide]) {
      expect(() => ipc.handlers.get(ch)?.(notTray, { type: "quit" })).toThrow(/disallowed frame/);
    }
    expect(d.performAction).not.toHaveBeenCalled();
    expect(d.hide).not.toHaveBeenCalled();
  });

  it("validates and forwards an action", () => {
    const ipc = fakeIpc();
    const d = deps();
    registerTrayBridge(ipc, d);
    ipc.handlers.get(TRAY_CHANNELS.action)?.(fromTray, { type: "setAutostart", value: true });
    expect(d.performAction).toHaveBeenCalledWith({ type: "setAutostart", value: true });
    expect(() => ipc.handlers.get(TRAY_CHANNELS.action)?.(fromTray, { type: "bogus" })).toThrow();
  });

  it("validates and forwards the measured height, and dismisses on hide", () => {
    const ipc = fakeIpc();
    const d = deps();
    registerTrayBridge(ipc, d);
    ipc.handlers.get(TRAY_CHANNELS.resize)?.(fromTray, 260);
    expect(d.setContentHeight).toHaveBeenCalledWith(260);
    expect(() => ipc.handlers.get(TRAY_CHANNELS.resize)?.(fromTray, -1)).toThrow();
    ipc.handlers.get(TRAY_CHANNELS.hide)?.(fromTray, undefined);
    expect(d.hide).toHaveBeenCalledOnce();
  });
});
