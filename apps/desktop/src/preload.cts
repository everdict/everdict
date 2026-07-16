// Preload — the renderer-side half of the window.everdictDesktop bridge (skill desktop invariant 3: these four + the subscription are all there is).
// The channel strings are manually kept in sync with bridge.ts BRIDGE_CHANNELS (this file is sandbox CJS and cannot import ESM modules).
// First gate: exposed only when the document origin matches the web origin main passed via additionalArguments —
// while top-level navigation has gone out to Keycloak/GitHub, the bridge itself is absent. (The real permission boundary is
// main's senderFrame origin check — bridge.ts. Defense in depth.)
import electron = require("electron");

// A sandbox preload runs in the renderer document context, so location exists — with a DOM-lib-free tsconfig, just a minimal declaration.
declare const location: { origin: string };

const ORIGIN_FLAG = "--everdict-web-origin=";
const expectedOrigin = process.argv.find((a) => a.startsWith(ORIGIN_FLAG))?.slice(ORIGIN_FLAG.length);

// Setup-window-only bridge — two methods to get/set the server address (D8). Because the main-side IPC allows only
// setup.html's file:// URL (main.ts), this surface never reaches web/external pages.
if (process.argv.includes("--everdict-setup")) {
  electron.contextBridge.exposeInMainWorld("everdictSetup", {
    getServerUrl: () => electron.ipcRenderer.invoke("everdict:get-server-url"),
    setServerUrl: (url: string) => electron.ipcRenderer.invoke("everdict:set-server-url", url),
  });
}

// Tray popover bridge (D11) — the rich, readable replacement for the native tray menu. Exposed only under the
// --everdict-tray flag (the popover window). Like everdictSetup, the real gate is main's senderFrame exact-file-URL
// check (tray-popover.ts registerTrayBridge). Channel strings are kept in sync with tray-popover.ts TRAY_CHANNELS.
if (process.argv.includes("--everdict-tray")) {
  electron.contextBridge.exposeInMainWorld("everdictTray", {
    getState: () => electron.ipcRenderer.invoke("everdict:tray-state"),
    action: (payload: unknown) => electron.ipcRenderer.invoke("everdict:tray-action", payload),
    resize: (height: number) => electron.ipcRenderer.invoke("everdict:tray-resize", height),
    hide: () => electron.ipcRenderer.invoke("everdict:tray-hide"),
    onState: (callback: (state: unknown) => void) => {
      const listener = (_event: electron.IpcRendererEvent, state: unknown) => callback(state);
      electron.ipcRenderer.on("everdict:tray-state-event", listener);
      return () => electron.ipcRenderer.removeListener("everdict:tray-state-event", listener);
    },
  });
}

if (expectedOrigin !== undefined && location.origin === expectedOrigin) {
  electron.contextBridge.exposeInMainWorld("everdictDesktop", {
    appInfo: () => electron.ipcRenderer.invoke("everdict:app-info"),
    // Additive pairing (D9): each call registers one more runner keyed by runnerId.
    pairRunner: (payload: unknown) => electron.ipcRenderer.invoke("everdict:pair-runner", payload),
    // unpairRunner(runnerId?) — a specific runner, or (omitted) all runners on this device.
    unpairRunner: (runnerId?: string) => electron.ipcRenderer.invoke("everdict:unpair-runner", runnerId),
    runnerStatus: () => electron.ipcRenderer.invoke("everdict:runner-status"),
    onRunnerStatus: (callback: (status: unknown) => void) => {
      const listener = (_event: electron.IpcRendererEvent, status: unknown) => callback(status);
      electron.ipcRenderer.on("everdict:runner-status-event", listener);
      return () => electron.ipcRenderer.removeListener("everdict:runner-status-event", listener);
    },
    // Frameless custom title bar (D10) — the web draws the bar and drives the OS window through these. Channel strings
    // are manually kept in sync with window-chrome.ts WINDOW_CHANNELS (this file is sandbox CJS and cannot import ESM).
    // Present only when the OS window is frameless (see main.ts), so the web renders NO custom bar on an older/native shell.
    window: {
      minimize: () => electron.ipcRenderer.invoke("everdict:window-minimize"),
      toggleMaximize: () => electron.ipcRenderer.invoke("everdict:window-toggle-maximize"),
      close: () => electron.ipcRenderer.invoke("everdict:window-close"),
      isMaximized: () => electron.ipcRenderer.invoke("everdict:window-is-maximized"),
      onMaximizeChange: (callback: (maximized: unknown) => void) => {
        const listener = (_event: electron.IpcRendererEvent, maximized: unknown) => callback(maximized);
        electron.ipcRenderer.on("everdict:window-maximize-event", listener);
        return () => electron.ipcRenderer.removeListener("everdict:window-maximize-event", listener);
      },
    },
  });
}
