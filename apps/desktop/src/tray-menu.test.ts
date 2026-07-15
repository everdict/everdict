import { describe, expect, it, vi } from "vitest";
import type { DesktopRunnerStatus, DesktopRunnersStatus } from "./bridge.js";
import { type TrayMenuActions, buildTrayMenuTemplate, runnerStatusLabel } from "./tray-menu.js";
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

function actions(): TrayMenuActions & { openApp: ReturnType<typeof vi.fn> } {
  return {
    openApp: vi.fn(),
    setAutostart: vi.fn(),
    changeServerUrl: vi.fn(),
    unpairRunner: vi.fn(),
    applyUpdate: vi.fn(),
    quit: vi.fn(),
  };
}

// electron calls click as (menuItem, window, event) but the template builder ignores the arguments — verify with a no-arg call.
function click(item: { click?: unknown }): void {
  (item.click as () => void)();
}

describe("runnerStatusLabel", () => {
  it("distinguishes unpaired/idle/running(n) for a single runner (unchanged phrasing)", () => {
    expect(runnerStatusLabel(OFF)).toContain("unpaired");
    expect(runnerStatusLabel(IDLE)).toBe("Runner: online, idle");
    expect(runnerStatusLabel(BUSY)).toBe("Runner: running (2)");
  });

  it("aggregates several runners (D9) — pool count + summed active jobs", () => {
    const pool: DesktopRunnersStatus = {
      runners: [runner({ runnerId: "r1", state: "idle" }), runner({ runnerId: "r2", state: "off" })],
    };
    expect(runnerStatusLabel(pool)).toBe("Runner: 1/2 online, idle");
    const busyPool: DesktopRunnersStatus = {
      runners: [
        runner({ runnerId: "r1", state: "running", activeJobs: 1 }),
        runner({ runnerId: "r2", state: "running", activeJobs: 2 }),
      ],
    };
    expect(runnerStatusLabel(busyPool)).toBe("Runner: running (3) · 2/2 online");
  });
});

describe("buildTrayMenuTemplate", () => {
  it("shows the status row (disabled)/open/autostart/quit — no unpair item when unpaired", () => {
    const t = buildTrayMenuTemplate({ autostart: false, runner: OFF, updater: NO_UPDATE }, actions());
    expect(t[0]).toMatchObject({ enabled: false });
    expect(t.map((i) => i.label ?? i.type)).toEqual([
      runnerStatusLabel(OFF),
      "separator",
      "Open Everdict",
      "separator",
      "Start at login",
      "Change server address…",
      "separator",
      "Quit",
    ]);
  });

  it("when paired, 'Unpair this device's runner' appears and clicking it calls unpairRunner", () => {
    const a = actions();
    const t = buildTrayMenuTemplate({ autostart: false, runner: IDLE, updater: NO_UPDATE }, a);
    const unpair = t.find((i) => i.label === "Unpair this device's runner");
    expect(unpair).toBeDefined();
    click(unpair ?? {});
    expect(a.unpairRunner).toHaveBeenCalledOnce();
  });

  it("reflects the autostart checked state, and a click calls setAutostart with the inverted value", () => {
    const a = actions();
    const on = buildTrayMenuTemplate({ autostart: true, runner: OFF, updater: NO_UPDATE }, a);
    const toggle = on.find((i) => i.label === "Start at login");
    expect(toggle?.checked).toBe(true);
    click(toggle ?? {});
    expect(a.setAutostart).toHaveBeenCalledWith(false);
  });

  it("shows a disabled progress row while downloading, and an apply item when ready (click→applyUpdate)", () => {
    const a = actions();
    const downloading = buildTrayMenuTemplate(
      { autostart: false, runner: OFF, updater: { kind: "downloading", version: "9.9.9", percent: 42 } },
      a,
    );
    expect(downloading[0]).toMatchObject({ label: "Downloading update… (42%)", enabled: false });

    const ready = buildTrayMenuTemplate(
      { autostart: false, runner: OFF, updater: { kind: "ready", version: "9.9.9" } },
      a,
    );
    const apply = ready.find((i) => i.label === "Apply update v9.9.9 (restart)");
    expect(apply).toBeDefined();
    click(apply ?? {});
    expect(a.applyUpdate).toHaveBeenCalledOnce();
  });

  it("clicking 'Change server address…' calls changeServerUrl", () => {
    const a = actions();
    const t = buildTrayMenuTemplate({ autostart: false, runner: OFF, updater: NO_UPDATE }, a);
    click(t.find((i) => i.label === "Change server address…") ?? {});
    expect(a.changeServerUrl).toHaveBeenCalledOnce();
  });

  it("clicking open/quit calls the actions", () => {
    const a = actions();
    const t = buildTrayMenuTemplate({ autostart: false, runner: OFF, updater: NO_UPDATE }, a);
    click(t.find((i) => i.label === "Open Everdict") ?? {});
    click(t.find((i) => i.label === "Quit") ?? {});
    expect(a.openApp).toHaveBeenCalledOnce();
    expect(a.quit).toHaveBeenCalledOnce();
  });
});
