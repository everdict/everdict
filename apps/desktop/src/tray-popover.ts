import { z } from "zod";
import type { DesktopRunnersStatus, IpcMainLike } from "./bridge.js";
import { type TrayMenuState, runnerStatusLabel } from "./tray-menu.js";
import type { UpdaterState } from "./updater.js";

// The custom tray popover (desktop decision D11) — a frameless BrowserWindow rendering a local page, replacing the native
// context menu whose text the OS theme made unreadable. This module is the PURE half (no electron value import, easy to
// test): the plain-JSON view model the popover renders, the popover placement math, the tray-action contract, and the
// main-side bridge registration. main.ts owns the window/screen/IPC glue. Its own local-file bridge (--everdict-tray) is
// gated exactly like the setup window (D8): main only accepts IPC whose senderFrame is the popover's file:// URL.

// The aggregate runner state that drives the status-dot reaction (idle = breathe, running = pulse ring): running if any
// job is in flight, else idle if any runner is online, else off.
export function aggregateRunnerState(status: DesktopRunnersStatus): "off" | "idle" | "running" {
  const active = status.runners.reduce((sum, r) => sum + r.activeJobs, 0);
  if (active > 0) return "running";
  if (status.runners.some((r) => r.state !== "off")) return "idle";
  return "off";
}

// The update row of the popover — precomputed so the renderer stays logic-free (mirrors tray-menu's updaterItems).
export interface TrayPopoverUpdate {
  kind: "none" | "downloading" | "ready";
  label?: string;
  version?: string;
  percent?: number;
}

function updateView(updater: UpdaterState): TrayPopoverUpdate {
  if (updater.kind === "downloading") {
    const base = { kind: "downloading" as const };
    if (updater.percent === undefined) return { ...base, label: "Downloading update…" };
    return { ...base, label: `Downloading update… (${updater.percent}%)`, percent: updater.percent };
  }
  if (updater.kind === "ready")
    return { kind: "ready", version: updater.version, label: `Apply update v${updater.version}` };
  return { kind: "none" };
}

// The whole plain-JSON view model the popover HTML renders — every display string is precomputed here so the renderer only
// paints (and reacts). The renderer never sees the raw runner/updater shapes.
export interface TrayPopoverViewModel {
  runnerLabel: string;
  runnerState: "off" | "idle" | "running";
  activeJobs: number;
  autostart: boolean;
  canUnpair: boolean;
  unpairLabel: string;
  update: TrayPopoverUpdate;
}

export function buildTrayPopoverViewModel(state: TrayMenuState): TrayPopoverViewModel {
  const count = state.runner.runners.length;
  return {
    runnerLabel: runnerStatusLabel(state.runner),
    runnerState: aggregateRunnerState(state.runner),
    activeJobs: state.runner.runners.reduce((sum, r) => sum + r.activeJobs, 0),
    autostart: state.autostart,
    canUnpair: count > 0,
    // Same phrasing as the native menu's unpair item (tray-menu.ts) so the two entry points read identically.
    unpairLabel: count === 1 ? "Unpair this device's runner" : "Unpair all runners on this device",
    update: updateView(state.updater),
  };
}

// --- Popover placement ---------------------------------------------------------------------------------------------

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface Size {
  width: number;
  height: number;
}

export interface PopoverPositionArgs {
  tray: Rect; // tray icon bounds; all-zero when the OS reports no geometry (common on Linux AppIndicator)
  size: Size; // the popover window size
  workArea: Rect; // the target display's usable area (screen minus panels/docks)
  gap?: number; // gap between the tray icon and the popover
}

const DEFAULT_GAP = 6;

// Anchor the popover to the tray icon, clamped inside the work area. With no usable tray geometry (Linux AppIndicator),
// fall back to the top-right corner — where a status area typically lives — since there the popover is opened from the
// menu launcher, not by clicking a positioned icon.
export function popoverPosition(args: PopoverPositionArgs): { x: number; y: number } {
  const gap = args.gap ?? DEFAULT_GAP;
  const { tray, size, workArea } = args;
  const clampX = (x: number): number => Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - size.width));
  const clampY = (y: number): number => Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - size.height));

  if (tray.width === 0 && tray.height === 0) {
    return { x: clampX(workArea.x + workArea.width - size.width - gap), y: workArea.y + gap };
  }

  const x = clampX(Math.round(tray.x + tray.width / 2 - size.width / 2));
  // Tray in the top half of its display → drop below the icon (macOS menu bar); bottom half → rise above it (Windows taskbar).
  const trayCenterY = tray.y + tray.height / 2;
  const below = trayCenterY < workArea.y + workArea.height / 2;
  const y = below ? clampY(tray.y + tray.height + gap) : clampY(tray.y - size.height - gap);
  return { x, y };
}

// --- The tray popover bridge (main-side) ---------------------------------------------------------------------------

export const TRAY_CHANNELS = {
  state: "everdict:tray-state", // invoke → TrayPopoverViewModel (initial render)
  action: "everdict:tray-action", // invoke(TrayAction) → perform a menu action
  resize: "everdict:tray-resize", // invoke(number) → the renderer's measured content height (main sizes the frameless window)
  hide: "everdict:tray-hide", // invoke() → dismiss (Escape)
  stateEvent: "everdict:tray-state-event", // main → renderer push: live state update while open
} as const;

// The action the popover asks main to perform — a discriminated union so `value` is only present for the toggle.
export const TrayActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("openApp") }),
  z.object({ type: z.literal("setAutostart"), value: z.boolean() }),
  z.object({ type: z.literal("changeServer") }),
  z.object({ type: z.literal("unpair") }),
  z.object({ type: z.literal("applyUpdate") }),
  z.object({ type: z.literal("quit") }),
]);
export type TrayAction = z.infer<typeof TrayActionSchema>;

// The renderer reports its rendered content height so main can fit the frameless window; clamp to a sane range.
export const TrayResizeSchema = z.number().int().positive().max(2000);

export interface TrayBridgeDeps {
  // The popover is a trusted local file — only its exact file:// frame may drive these (mirrors the setup-window gate, D8/D11).
  fromTrayPage(frameUrl: string | undefined): boolean;
  getState(): TrayMenuState;
  performAction(action: TrayAction): void;
  setContentHeight(height: number): void;
  hide(): void;
}

export function registerTrayBridge(ipc: IpcMainLike, deps: TrayBridgeDeps): void {
  const guarded =
    (handler: (payload: unknown) => unknown) =>
    (event: { senderFrame: { url: string } | null }, payload: unknown): unknown => {
      if (!deps.fromTrayPage(event.senderFrame?.url)) throw new Error("Tray popover call from a disallowed frame.");
      return handler(payload);
    };
  ipc.handle(
    TRAY_CHANNELS.state,
    guarded(() => buildTrayPopoverViewModel(deps.getState())),
  );
  ipc.handle(
    TRAY_CHANNELS.action,
    guarded((payload) => deps.performAction(TrayActionSchema.parse(payload))),
  );
  ipc.handle(
    TRAY_CHANNELS.resize,
    guarded((payload) => deps.setContentHeight(TrayResizeSchema.parse(payload))),
  );
  ipc.handle(
    TRAY_CHANNELS.hide,
    guarded(() => deps.hide()),
  );
}
