import { describe, expect, it, vi } from "vitest";
import { type ChromeInvokeEvent, WINDOW_CHANNELS, type WindowLike, registerWindowChrome } from "./window-chrome.js";

const WEB = "https://app.everdict.dev";

function fakeIpc(): {
  handle(channel: string, listener: (event: ChromeInvokeEvent) => unknown): void;
  invoke(channel: string, frameUrl: string | undefined, sender?: unknown): unknown;
} {
  const handlers = new Map<string, (event: ChromeInvokeEvent) => unknown>();
  return {
    handle: (ch, l) => {
      handlers.set(ch, l);
    },
    invoke: (ch, frameUrl, sender = {}) => {
      const h = handlers.get(ch);
      if (!h) throw new Error(`no handler: ${ch}`);
      return h({ senderFrame: frameUrl === undefined ? null : { url: frameUrl }, sender });
    },
  };
}

function fakeWindow(): WindowLike & {
  minimize: ReturnType<typeof vi.fn>;
  maximize: ReturnType<typeof vi.fn>;
  unmaximize: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  let maximized = false;
  return {
    minimize: vi.fn(),
    maximize: vi.fn(() => {
      maximized = true;
    }),
    unmaximize: vi.fn(() => {
      maximized = false;
    }),
    isMaximized: () => maximized,
    close: vi.fn(),
  };
}

describe("registerWindowChrome", () => {
  it("blocks every window control for a call from another origin (e.g. an OAuth page)", () => {
    const ipc = fakeIpc();
    const win = fakeWindow();
    registerWindowChrome(ipc, { webOrigin: () => WEB, windowForSender: () => win });
    for (const ch of [
      WINDOW_CHANNELS.minimize,
      WINDOW_CHANNELS.toggleMaximize,
      WINDOW_CHANNELS.close,
      WINDOW_CHANNELS.isMaximized,
    ]) {
      expect(() => ipc.invoke(ch, "https://keycloak.everdict.dev/auth")).toThrow(/origin/);
      expect(() => ipc.invoke(ch, undefined)).toThrow(/origin/);
    }
    expect(win.minimize).not.toHaveBeenCalled();
  });

  it("drives the sending window for a web-origin call (minimize · close · maximize toggle)", () => {
    const ipc = fakeIpc();
    const win = fakeWindow();
    registerWindowChrome(ipc, { webOrigin: () => WEB, windowForSender: () => win });
    ipc.invoke(WINDOW_CHANNELS.minimize, `${WEB}/acme`);
    expect(win.minimize).toHaveBeenCalledOnce();
    ipc.invoke(WINDOW_CHANNELS.close, `${WEB}/acme`);
    expect(win.close).toHaveBeenCalledOnce();
    // toggle: not-maximized → maximize, then maximized → unmaximize; isMaximized reflects each step.
    ipc.invoke(WINDOW_CHANNELS.toggleMaximize, `${WEB}/acme`);
    expect(win.maximize).toHaveBeenCalledOnce();
    expect(ipc.invoke(WINDOW_CHANNELS.isMaximized, `${WEB}/acme`)).toBe(true);
    ipc.invoke(WINDOW_CHANNELS.toggleMaximize, `${WEB}/acme`);
    expect(win.unmaximize).toHaveBeenCalledOnce();
    expect(ipc.invoke(WINDOW_CHANNELS.isMaximized, `${WEB}/acme`)).toBe(false);
  });

  it("is a no-op (no throw) when the sending window has gone away", () => {
    const ipc = fakeIpc();
    registerWindowChrome(ipc, { webOrigin: () => WEB, windowForSender: () => null });
    expect(() => ipc.invoke(WINDOW_CHANNELS.minimize, `${WEB}/acme`)).not.toThrow();
  });

  it("blocks when no server is configured (webOrigin null)", () => {
    const ipc = fakeIpc();
    const win = fakeWindow();
    registerWindowChrome(ipc, { webOrigin: () => null, windowForSender: () => win });
    expect(() => ipc.invoke(WINDOW_CHANNELS.minimize, `${WEB}/acme`)).toThrow(/origin/);
    expect(win.minimize).not.toHaveBeenCalled();
  });
});
