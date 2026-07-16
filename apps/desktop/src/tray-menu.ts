import type { MenuItemConstructorOptions } from "electron";
import type { DesktopRunnersStatus } from "./bridge.js";
import type { UpdaterState } from "./updater.js";

// Tray menu template — a pure builder (no electron value import, easy to test). State and actions are injected by main.
export interface TrayMenuState {
  autostart: boolean;
  runner: DesktopRunnersStatus; // every runner paired on this device (D9)
  updater: UpdaterState;
}

export interface TrayMenuActions {
  openApp(): void;
  openPanel(): void; // open the rich popover (D11) — on Linux the native menu is kept (AppIndicator forces one) but leads into the readable popover
  setAutostart(next: boolean): void;
  changeServerUrl(): void; // open the setup window (setup.html) — D8
  reconnectRunner(): void; // force every runner on this device to reconnect (recover an offline runner without re-pairing)
  unpairRunner(): void;
  applyUpdate(): void; // shown only in the ready state — cleaning up the runner then restarting/applying is main's responsibility
  quit(): void;
}

// One-line summary of the aggregate runner status (D9) — shared by the tray status row/tooltip. With a single runner it reads exactly
// as before; with several it adds a pool count.
export function runnerStatusLabel(status: DesktopRunnersStatus): string {
  const count = status.runners.length;
  if (count === 0) return "Runner: unpaired (connect from the account page)";
  const online = status.runners.filter((r) => r.state !== "off").length;
  const jobs = status.runners.reduce((sum, r) => sum + r.activeJobs, 0);
  const pool = count > 1 ? ` · ${online}/${count} online` : "";
  if (jobs > 0) return `Runner: running (${jobs})${pool}`;
  if (online > 0) return count > 1 ? `Runner: ${online}/${count} online, idle` : "Runner: online, idle";
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
    // The native menu's text is at the mercy of the OS/GTK theme (unstylable, low-contrast on some Linux themes — the reason
    // D11 exists). Its first, always-legible job is to open the fully-styled popover; the rest stays as a complete fallback.
    { label: "Open Everdict panel", click: () => actions.openPanel() },
    { type: "separator" },
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
    // Reconnect — force this device's runner(s) to reopen their session and resume leasing. The recovery for a runner that
    // shows "offline" (its lease loop can't reach the control plane), avoiding a full unpair + re-pair.
    ...(state.runner.runners.length > 0
      ? ([
          {
            label:
              state.runner.runners.length === 1
                ? "Reconnect this device's runner"
                : "Reconnect all runners on this device",
            click: () => actions.reconnectRunner(),
          },
        ] satisfies MenuItemConstructorOptions[])
      : []),
    // Local unpair — discard this device's token(s) + stop the runner(s). The web account page is authoritative for revoking the server-side records.
    ...(state.runner.runners.length > 0
      ? ([
          {
            label:
              state.runner.runners.length === 1 ? "Unpair this device's runner" : "Unpair all runners on this device",
            click: () => actions.unpairRunner(),
          },
        ] satisfies MenuItemConstructorOptions[])
      : []),
    { type: "separator" },
    { label: "Quit", click: () => actions.quit() },
  ];
}
