import { senderAllowed } from "./bridge.js";

// Frameless custom title bar (desktop decision D10): the web draws the whole title bar — brand · drag region ·
// minimize/maximize/close — and drives the OS window through these origin-gated IPC channels. This is the
// window-chrome half of window.everdictDesktop, kept SEPARATE from the runner bridge (bridge.ts) because it is a
// distinct concern (benign window management, no fs/shell/Node power) and, unlike the runner bridge, it needs the
// *sending* window. The permission boundary is unchanged (skill desktop invariant 4): only a web-origin frame drives it.
// The channel strings are manually kept in sync with preload.cts (preload is CJS and cannot import this module).
export const WINDOW_CHANNELS = {
  minimize: "everdict:window-minimize",
  toggleMaximize: "everdict:window-toggle-maximize",
  close: "everdict:window-close",
  isMaximized: "everdict:window-is-maximized",
  // main → renderer push: the maximized state changed (the web toggles the maximize/restore glyph + corner styling).
  maximizeEvent: "everdict:window-maximize-event",
} as const;

// The minimal window surface the chrome handlers act on — electron's BrowserWindow satisfies it structurally (tests inject a fake).
export interface WindowLike {
  minimize(): void;
  maximize(): void;
  unmaximize(): void;
  isMaximized(): boolean;
  close(): void;
}

// The invoke event seen here — senderFrame for the origin gate + an opaque sender the injected resolver maps to the window.
export interface ChromeInvokeEvent {
  senderFrame: { url: string } | null;
  sender: unknown;
}
export interface ChromeIpcMainLike {
  handle(channel: string, listener: (event: ChromeInvokeEvent) => unknown): void;
}

export interface WindowChromeDeps {
  // Re-read the current web origin on every call (D8: the server address can change at runtime); null = not configured → block.
  webOrigin(): string | null;
  // Resolve the window that sent the call (main: BrowserWindow.fromWebContents(sender)); null when it has gone away.
  windowForSender(sender: unknown): WindowLike | null;
}

export function registerWindowChrome(ipc: ChromeIpcMainLike, deps: WindowChromeDeps): void {
  const guarded =
    (handler: (win: WindowLike) => unknown) =>
    (event: ChromeInvokeEvent): unknown => {
      const origin = deps.webOrigin();
      if (origin === null || !senderAllowed(event.senderFrame?.url, origin))
        throw new Error("Window control from a disallowed origin.");
      const win = deps.windowForSender(event.sender);
      if (win === null) return;
      return handler(win);
    };
  ipc.handle(
    WINDOW_CHANNELS.minimize,
    guarded((win) => win.minimize()),
  );
  ipc.handle(
    WINDOW_CHANNELS.toggleMaximize,
    guarded((win) => (win.isMaximized() ? win.unmaximize() : win.maximize())),
  );
  ipc.handle(
    WINDOW_CHANNELS.close,
    guarded((win) => win.close()),
  );
  ipc.handle(
    WINDOW_CHANNELS.isMaximized,
    guarded((win) => win.isMaximized()),
  );
}
