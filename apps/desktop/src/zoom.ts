// Ctrl/Cmd +/−/0 page zoom for the app window. We intentionally do NOT rely on Electron's default menu here:
// the frameless custom title bar (D10) hides the menu bar on Windows/Linux, and — the real bug — the default
// zoom-in role's accelerator is "CommandOrControl+Plus", which never matches Ctrl+= on common layouts (the "+"
// key is Shift+= there), so only zoom-OUT and reset ever fired. We take zoom over in the main process via
// before-input-event: calling event.preventDefault() there suppresses both the page keystroke AND the menu
// shortcut, so there is no double handling, and it is keyboard-layout agnostic (accepts "+", "=", numpad, …).

// One Chromium zoom level step ≈ a 1.2× factor; 0.5 gives a ~9.6% increment per press. Clamp to a sane range
// (≈ 48%–207%) so a stuck key can't zoom into oblivion.
const ZOOM_STEP = 0.5;
const ZOOM_MIN = -4;
const ZOOM_MAX = 4;

// The subset of Electron's `Input` we read — the real event satisfies it structurally (tests inject a fake).
export interface ZoomInput {
  readonly type: string; // "keyDown" | "keyUp"
  readonly key: string; // KeyboardEvent.key: "+", "=", "-", "0", … (numpad +/- also report "+"/"-")
  readonly control: boolean;
  readonly meta: boolean;
  readonly alt: boolean;
}

// Pure decision: the next zoom level for a key event given the current level, or null when the event is not a
// zoom shortcut (so the caller leaves it untouched). Requires Ctrl or Cmd, and rejects Alt to avoid stealing
// unrelated chords. Both the shifted ("+"/"_") and unshifted ("="/"-") glyphs of the +/− keys map to zoom.
export function nextZoomLevel(input: ZoomInput, current: number): number | null {
  if (input.type !== "keyDown" || input.alt || !(input.control || input.meta)) return null;
  switch (input.key) {
    case "+":
    case "=":
      return Math.min(ZOOM_MAX, current + ZOOM_STEP);
    case "-":
    case "_":
      return Math.max(ZOOM_MIN, current - ZOOM_STEP);
    case "0":
      return 0;
    default:
      return null;
  }
}

// The minimal webContents surface we drive — Electron's WebContents satisfies it structurally.
export interface ZoomableContents {
  on(event: "before-input-event", listener: (event: { preventDefault(): void }, input: ZoomInput) => void): void;
  getZoomLevel(): number;
  setZoomLevel(level: number): void;
}

// Wire Ctrl/Cmd +/−/0 zoom onto a window's webContents. preventDefault() also blocks the default menu's
// (broken) zoom accelerators, so this becomes the single source of zoom behavior.
export function registerZoomShortcuts(contents: ZoomableContents): void {
  contents.on("before-input-event", (event, input) => {
    const next = nextZoomLevel(input, contents.getZoomLevel());
    if (next === null) return;
    event.preventDefault();
    contents.setZoomLevel(next);
  });
}
