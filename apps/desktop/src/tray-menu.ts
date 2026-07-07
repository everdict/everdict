import type { MenuItemConstructorOptions } from "electron";
import type { DesktopRunnerStatus } from "./bridge.js";
import type { UpdaterState } from "./updater.js";

// Tray menu template — a pure builder (no electron value import, easy to test). State and actions are injected by main.
export interface TrayMenuState {
  autostart: boolean;
  runner: DesktopRunnerStatus;
  updater: UpdaterState;
}

export interface TrayMenuActions {
  openApp(): void;
  setAutostart(next: boolean): void;
  changeServerUrl(): void; // open the setup window (setup.html) — D8
  unpairRunner(): void;
  applyUpdate(): void; // shown only in the ready state — cleaning up the runner then restarting/applying is main's responsibility
  quit(): void;
}

// One-line summary of the runner status — shared by the tray status row/tooltip.
export function runnerStatusLabel(runner: DesktopRunnerStatus): string {
  if (!runner.paired) return "Runner: unpaired (connect from the account page)";
  if (runner.state === "running") return `Runner: running (${runner.activeJobs})`;
  if (runner.state === "idle") return "Runner: online, idle";
  return "Runner: off";
}

// Update menu rows — downloading is a progress indicator (disabled), ready is the apply action. Other states show no row (keeps the menu concise).
function updaterItems(updater: UpdaterState, actions: TrayMenuActions): MenuItemConstructorOptions[] {
  if (updater.kind === "downloading") {
    const pct = updater.percent !== undefined ? ` (${updater.percent}%)` : "";
    return [{ label: `Downloading update…${pct}`, enabled: false }, { type: "separator" }];
  }
  if (updater.kind === "ready") {
    return [
      { label: `Apply update v${updater.version} (restart)`, click: () => actions.applyUpdate() },
      { type: "separator" },
    ];
  }
  return [];
}

export function buildTrayMenuTemplate(state: TrayMenuState, actions: TrayMenuActions): MenuItemConstructorOptions[] {
  return [
    ...updaterItems(state.updater, actions),
    { label: runnerStatusLabel(state.runner), enabled: false },
    { type: "separator" },
    { label: "Open Everdict", click: () => actions.openApp() },
    { type: "separator" },
    {
      label: "Start at login",
      type: "checkbox",
      checked: state.autostart,
      click: () => actions.setAutostart(!state.autostart),
    },
    { label: "Change server address…", click: () => actions.changeServerUrl() },
    // Local unpair — discard this device's token + stop the runner. The web account page is authoritative for revoking the server-side runner record.
    ...(state.runner.paired
      ? ([
          { label: "Unpair this device's runner", click: () => actions.unpairRunner() },
        ] satisfies MenuItemConstructorOptions[])
      : []),
    { type: "separator" },
    { label: "Quit", click: () => actions.quit() },
  ];
}
