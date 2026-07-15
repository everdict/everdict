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
  });
}
