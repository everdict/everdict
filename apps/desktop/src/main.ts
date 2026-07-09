import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ResilientMcpSession, RunnerHost, detectCapabilities, mcpConnect } from "@everdict/self-hosted-runner";
import { BrowserWindow, Menu, Notification, Tray, app, ipcMain, nativeImage, safeStorage, shell } from "electron";
import electronUpdater from "electron-updater";
import {
  BRIDGE_CHANNELS,
  type DesktopAppInfo,
  type DesktopRunnerStatus,
  registerBridge,
  senderAllowed,
} from "./bridge.js";
import { type ConfigIo, type DesktopConfig, loadConfig, saveConfig } from "./config-store.js";
import { NotificationWatcher, type WatcherNotification } from "./notification-watcher.js";
import { RunnerController } from "./runner-controller.js";
import { normalizeWebUrl, resolveWebUrl } from "./server-url.js";
import { type TokenIo, clearToken, loadToken, saveToken } from "./token-store.js";
import { buildTrayMenuTemplate, runnerStatusLabel } from "./tray-menu.js";
import { type AutoUpdaterLike, UpdaterController, type UpdaterState } from "./updater.js";
import { allowTopLevelNavigation, decideWindowOpen, shouldRecoverToSetup, webOriginOf } from "./window-policy.js";

// Desktop shell — renders the deployed web as-is (D1: UI SSOT = apps/web), stays resident in the tray, and
// embeds the self-hosted runner (@everdict/runner-core) in the main process (D3: one-click pairing).
// Design: docs/architecture/desktop-app.md · conventions: .claude/skills/desktop/SKILL.md.

// Default server URL that CI bakes into release builds (esbuild define) — not defined in dev (tsc) (D8).
declare const __EVERDICT_DEFAULT_WEB_URL__: string | undefined;

// The web (server) URL is mutable (D8) — env (dev/e2e) > config (user-saved) > CI-injected default. If none, the setup screen.
let webUrl: string | null = null;
let webOrigin: string | null = null;
function applyWebUrl(url: string | null): void {
  webUrl = url;
  webOrigin = url === null ? null : webOriginOf(url);
}

// The runner's control-plane default — the pairing payload's apiUrl takes precedence (the CONTROL_PLANE_URL the web server knows).
const defaultApiUrl = process.env.EVERDICT_API_URL ?? "http://localhost:8787";

// Skill desktop security invariant 2 — always these webPreferences on every window. preload takes the web origin
// as an argument for its origin gate (preload.cts).
function securePreferences(origin: string): Electron.WebPreferences {
  return {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    preload: path.join(import.meta.dirname, "preload.cjs"),
    additionalArguments: [`--everdict-web-origin=${origin}`],
  };
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let shuttingDown = false;
// D8 recovery: set when the pinned web URL fails its initial load (wrong/unreachable server). While true, the app window
// is a dead error page, so createOrFocusWindow routes to the setup screen instead — a tray-independent way back.
let webUrlLoadFailed = false;

// Store non-secret settings in userData's config.json (autostart · runner meta). The rnr_ token is never allowed here (invariant 5).
function configIo(): ConfigIo {
  const dir = app.getPath("userData");
  const file = path.join(dir, "config.json");
  return {
    read: () => (existsSync(file) ? readFileSync(file, "utf8") : null),
    write: (text) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, text);
    },
  };
}

// safeStorage ciphertext file IO for the rnr_ token — token-store handles encrypt/decrypt.
function tokenIo(): TokenIo {
  const dir = app.getPath("userData");
  const file = path.join(dir, "runner-token.bin");
  return {
    read: () => (existsSync(file) ? readFileSync(file) : null),
    write: (data) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, data);
    },
    remove: () => rmSync(file, { force: true }),
  };
}

let config: DesktopConfig;

function applyAutostart(next: boolean): void {
  config = { ...config, autostart: next };
  saveConfig(configIo(), config);
  // macOS/Windows only (Electron no-ops on Linux) — supplemented by a .desktop autostart in the packaging slice.
  app.setLoginItemSettings({ openAtLogin: next });
  refreshTrayMenu();
}

// Latest runner status referenced by the tray/notifications — updated by broadcast.
let latestRunnerStatus: DesktopRunnerStatus = { paired: false, state: "off", activeJobs: 0, capabilities: [] };
// Counters for the drain (running→idle) notification — notifying per case would spam in a batch.
let doneSinceIdle = 0;
let failedSinceIdle = 0;

// One notification on the running→idle transition (success/failure tally) — the local counterpart of the Mattermost completion notification.
function notifyDrainIfNeeded(prev: DesktopRunnerStatus, next: DesktopRunnerStatus): void {
  if (prev.state !== "running" || next.state !== "idle" || doneSinceIdle + failedSinceIdle === 0) return;
  const body = `${doneSinceIdle} succeeded · ${failedSinceIdle} failed`;
  doneSinceIdle = 0;
  failedSinceIdle = 0;
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title: "Everdict runner — jobs processed", body });
    n.on("click", () => createOrFocusWindow());
    n.show();
  } catch {
    /* environment without notification support (e.g. no libnotify) — ignore */
  }
}

// Independent notification watcher (N6) — polls the control-plane feed directly with the runner pairing token and fires OS notifications.
// Independent of any web session/window: even a web-less (runner-only) user gets "the work I started is done". Tied to the pairing lifecycle.
let notifyWatcher: NotificationWatcher | null = null;
let notifySession: ResilientMcpSession | null = null;

function notifyPathOf(row: WatcherNotification): string | null {
  if (row.link?.runId) return `/${row.workspace}/runs/${row.link.runId}`;
  if (row.link?.scorecardId) return `/${row.workspace}/scorecards/${row.link.scorecardId}`;
  return null;
}

function fireOsNotification(row: WatcherNotification): void {
  // Skip if the app window is visible — the web bell badge is already showing (the web side's firing is symmetric via the document.hidden gate).
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && mainWindow.isFocused()) return;
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title: row.title, ...(row.body ? { body: row.body } : {}) });
    n.on("click", () => {
      createOrFocusWindow();
      const path = notifyPathOf(row);
      if (path && webUrl !== null && mainWindow && !mainWindow.isDestroyed())
        void mainWindow.loadURL(`${webUrl}${path}`);
    });
    n.show();
  } catch {
    /* environment without notification support — ignore */
  }
}

function startNotifyWatcher(): void {
  if (notifyWatcher) return;
  const token = loadToken(safeStorage, tokenIo());
  if (token === null) return;
  const conf = loadConfig(configIo());
  const session = new ResilientMcpSession(mcpConnect(new URL("/mcp", conf.apiUrl ?? defaultApiUrl), token));
  notifySession = session;
  notifyWatcher = new NotificationWatcher({
    callJson: async (name, args) => {
      const r = await session.call(name, args);
      if (r.isError) throw new Error(r.text || `${name} failed`);
      return JSON.parse(r.text) as Record<string, unknown>;
    },
    notify: fireOsNotification,
    loadCursor: () => loadConfig(configIo()).notifyCursor,
    saveCursor: (iso) => {
      config = { ...loadConfig(configIo()), notifyCursor: iso };
      saveConfig(configIo(), config);
    },
    log: (m) => console.error(m),
  });
  notifyWatcher.start();
  console.error("▶ Independent notification watcher started (runner token — no web session needed)");
}

function stopNotifyWatcher(): void {
  notifyWatcher?.stop();
  notifyWatcher = null;
  const s = notifySession;
  notifySession = null;
  if (s) void s.close().catch(() => {});
}

// Runner controller — persists pair state + RunnerHost lifecycle. Status is pushed only to web-origin windows (the same boundary as invariant 4).
const controller = new RunnerController({
  loadToken: () => loadToken(safeStorage, tokenIo()),
  saveToken: (token) => saveToken(safeStorage, tokenIo(), token),
  clearToken: () => clearToken(tokenIo()),
  loadMeta: () => {
    const c = loadConfig(configIo());
    return {
      ...(c.runnerId !== undefined ? { runnerId: c.runnerId } : {}),
      ...(c.apiUrl !== undefined ? { apiUrl: c.apiUrl } : {}),
    };
  },
  saveMeta: (meta) => {
    const { runnerId: _r, apiUrl: _a, ...rest } = loadConfig(configIo());
    config = { ...rest, ...meta };
    saveConfig(configIo(), config);
  },
  makeHost: ({ token, apiUrl, onStatus }) =>
    new RunnerHost({
      token,
      apiUrl,
      onStatus,
      onJobDone: (done) => {
        if (done.error) failedSinceIdle++;
        else doneSinceIdle++;
      },
      log: (m) => console.error(m),
      // Desktop uses a shorter long-poll than the CLI (25s) to reduce shutdown latency (stop waits for the current poll to complete).
      waitMs: 8_000,
    }),
  defaultApiUrl,
  broadcast: (status) => {
    notifyDrainIfNeeded(latestRunnerStatus, status);
    latestRunnerStatus = status;
    // Independent notifications (N6): start the watcher when paired, stop it when unpaired — the feed flows regardless of any web session.
    if (status.paired) startNotifyWatcher();
    else stopNotifyWatcher();
    refreshTrayMenu(); // sync the status row · unpair item · tooltip (no-op if no tray)
    for (const win of BrowserWindow.getAllWindows()) {
      if (webOrigin !== null && senderAllowed(win.webContents.getURL(), webOrigin))
        win.webContents.send(BRIDGE_CHANNELS.statusEvent, status);
    }
  },
  log: (m) => console.error(m),
});

// Auto-update (design D6) — activation gate: packaged app && feed configured. The feed destination (a public
// releases repo vs making the repo public) awaits the user's decision — once settled, adding a publish block to
// electron-builder.yml ships app-update.yml in the package and auto-enables it. Until then, only manual/verification
// activation via EVERDICT_UPDATE_FEED_URL (a generic directory URL). dev (unpackaged) is always disabled.
function resolveAutoUpdater(): AutoUpdaterLike | null {
  if (!app.isPackaged) return null;
  const feedUrl = process.env.EVERDICT_UPDATE_FEED_URL;
  if (feedUrl) {
    // setFeedURL alone is insufficient — AppImageUpdater and others read app-update.yml (the on-disk config) during
    // the download step. On env activation, write a config file to userData and inject it via updateConfigPath.
    const configPath = path.join(app.getPath("userData"), "app-update.yml");
    mkdirSync(app.getPath("userData"), { recursive: true });
    writeFileSync(configPath, `provider: generic\nurl: ${JSON.stringify(feedUrl)}\n`);
    electronUpdater.autoUpdater.updateConfigPath = configPath;
    return electronUpdater.autoUpdater;
  }
  if (existsSync(path.join(process.resourcesPath, "app-update.yml"))) return electronUpdater.autoUpdater;
  return null;
}

let updaterState: UpdaterState = { kind: "disabled" };
const updater = new UpdaterController({
  updater: resolveAutoUpdater(),
  onStatus: (state) => {
    const prev = updaterState;
    updaterState = state;
    if (state.kind !== prev.kind)
      console.error(`Update status: ${state.kind}${"version" in state ? ` v${state.version}` : ""}`);
    refreshTrayMenu();
    // One notification on entering ready — applying it (restart) is the user's decision from the tray (no forced abort of runner jobs).
    if (state.kind === "ready" && prev.kind !== "ready") {
      try {
        if (Notification.isSupported()) {
          const n = new Notification({
            title: "Everdict update ready",
            body: `Restarting will update to v${state.version}. Apply it from the tray menu.`,
          });
          n.on("click", () => createOrFocusWindow());
          n.show();
        }
      } catch {
        /* environment without notification support — ignore */
      }
    }
  },
  log: (m) => console.error(m),
});

// Apply the update — gracefully clean up the runner, then restart and install. Set the flags first so it does not take
// the before-quit preventDefault path (so the install is not canceled midway).
function applyUpdateNow(): void {
  quitting = true;
  shuttingDown = true;
  void controller
    .shutdown()
    .catch(() => {})
    .finally(() => updater.quitAndInstall());
}

// appInfo — source of the one-click pairing label (hostname)/OS/capability. The capability probe is cached once.
let capabilitiesPromise: Promise<string[]> | null = null;
async function appInfo(): Promise<DesktopAppInfo> {
  capabilitiesPromise ??= detectCapabilities();
  return {
    version: app.getVersion(),
    platform: process.platform,
    hostname: hostname(),
    capabilities: await capabilitiesPromise,
  };
}

// First-run/server-change setup window — opens the local setup.html with the setup-only preload flag (D8).
let setupWindow: BrowserWindow | null = null;
function setupPageUrl(): string {
  return pathToFileURL(path.join(app.getAppPath(), "assets", "setup.html")).toString();
}
function openSetupWindow(): void {
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.show();
    setupWindow.focus();
    return;
  }
  const win = new BrowserWindow({
    width: 460,
    height: 400,
    resizable: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(import.meta.dirname, "preload.cjs"),
      additionalArguments: ["--everdict-setup"],
    },
  });
  win.setMenuBarVisibility(false);
  win.on("closed", () => {
    setupWindow = null;
  });
  void win.loadURL(setupPageUrl());
  setupWindow = win;
}

function createOrFocusWindow(): void {
  // Server not configured, or the configured server failed to load (wrong/unreachable URL) — show the setup screen
  // instead of the app window (the login screen is unreachable, and this path does not depend on the OS tray).
  if (webUrl === null || webOrigin === null || webUrlLoadFailed) {
    openSetupWindow();
    return;
  }
  const url = webUrl;
  const origin = webOrigin;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: securePreferences(origin),
  });
  // Recovery (D8): the pinned server URL might be wrong/unreachable. On a successful load, clear the failed flag; on the
  // initial top-level load failure, mark it and pop the setup screen so the user can fix the address without the tray.
  let everLoaded = false;
  win.webContents.on("did-finish-load", () => {
    everLoaded = true;
    webUrlLoadFailed = false;
  });
  win.webContents.on("did-fail-load", (_event, errorCode, _desc, _failedUrl, isMainFrame) => {
    if (!shouldRecoverToSetup({ errorCode, isMainFrame, everLoaded })) return;
    webUrlLoadFailed = true;
    openSetupWindow();
  });
  // window.open: only the web origin gets a new app window; other http/https go to the system browser (rationale in the window-policy.ts comment).
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    const decision = decideWindowOpen(target, origin);
    if (decision === "external") void shell.openExternal(target);
    if (decision !== "in-app") return { action: "deny" };
    return { action: "allow", overrideBrowserWindowOptions: { webPreferences: securePreferences(origin) } };
  });
  // Top-level navigation: allow only http/https (for OIDC/OAuth redirects); block other schemes.
  win.webContents.on("will-navigate", (event, url) => {
    if (!allowTopLevelNavigation(url)) event.preventDefault();
  });
  // Close = hide to the tray (keep the runner resident). Quit only from the tray menu.
  win.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
  });
  win.on("closed", () => {
    mainWindow = null;
  });
  void win.loadURL(url);
  mainWindow = win;
}

function refreshTrayMenu(): void {
  if (!tray) return;
  tray.setToolTip(`Everdict — ${runnerStatusLabel(latestRunnerStatus)}`);
  tray.setContextMenu(
    Menu.buildFromTemplate(
      buildTrayMenuTemplate(
        { autostart: config.autostart, runner: latestRunnerStatus, updater: updaterState },
        {
          openApp: () => createOrFocusWindow(),
          setAutostart: (next) => applyAutostart(next),
          changeServerUrl: () => openSetupWindow(),
          // Local unpair (discard the token + stop) — the web account page is authoritative for revoking the server record.
          unpairRunner: () => void controller.unpair().catch((e) => console.error(`Runner unpair failed: ${e}`)),
          applyUpdate: () => applyUpdateNow(),
          quit: () => {
            quitting = true;
            app.quit();
          },
        },
      ),
    ),
  );
}

function createTray(): void {
  const icon = nativeImage.createFromPath(path.join(app.getAppPath(), "assets", "tray.png"));
  tray = new Tray(icon);
  tray.on("click", () => createOrFocusWindow());
  refreshTrayMenu();
}

// Single instance — a second launch brings the existing window to the front.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => createOrFocusWindow());

  void app.whenReady().then(() => {
    // No Linux keyring (headless, etc.): if safeStorage falls back to the basic_text backend, then without an explicit opt-in
    // isEncryptionAvailable()=false → one-click pairing becomes impossible. We take the same fallback as VSCode —
    // warn that it is only obfuscation-level and opt in. With a GNOME/KDE keyring present, it is a real encryption backend and does not take this path.
    if (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text") {
      safeStorage.setUsePlainTextEncryption(true);
      console.error(
        "⚠ No OS keyring, so storing the runner token in safeStorage basic_text (obfuscation) — installing a keyring is recommended.",
      );
    }
    config = loadConfig(configIo());
    // Resolve the server URL (D8): env (dev/e2e) > user config > CI-injected default. If none, the setup screen appears.
    applyWebUrl(
      resolveWebUrl({
        envUrl: process.env.EVERDICT_WEB_URL,
        configUrl: config.webUrl,
        bakedUrl: typeof __EVERDICT_DEFAULT_WEB_URL__ === "undefined" ? undefined : __EVERDICT_DEFAULT_WEB_URL__,
      }),
    );

    // Setup-window-only IPC (D8) — allowed only from setup.html's file:// URL (web/external pages blocked).
    const fromSetupPage = (event: { senderFrame: { url: string } | null }): boolean =>
      event.senderFrame?.url === setupPageUrl();
    ipcMain.handle("everdict:get-server-url", (event) => {
      if (!fromSetupPage(event)) throw new Error("This call is not allowed.");
      return webUrl ?? "";
    });
    ipcMain.handle("everdict:set-server-url", (event, raw: unknown) => {
      if (!fromSetupPage(event)) throw new Error("This call is not allowed.");
      const url = normalizeWebUrl(typeof raw === "string" ? raw : null);
      if (url === null) throw new Error("Not a valid http/https server address.");
      config = { ...loadConfig(configIo()), webUrl: url };
      saveConfig(configIo(), config);
      applyWebUrl(url);
      // Give the newly-entered URL a fresh attempt — otherwise the load-failed gate would bounce it straight back to setup.
      webUrlLoadFailed = false;
      // The existing app window holds the previous origin's preload argument, so open a fresh one (destroy it, bypassing the close=hide handler).
      if (mainWindow && !mainWindow.isDestroyed()) {
        const old = mainWindow;
        mainWindow = null;
        old.destroy();
      }
      setupWindow?.close();
      createOrFocusWindow();
      refreshTrayMenu();
      return true;
    });
    registerBridge(ipcMain, {
      webOrigin: () => webOrigin,
      appInfo,
      pair: (payload) => controller.pair(payload),
      unpair: () => controller.unpair(),
      status: () => controller.status(),
    });
    createTray();
    createOrFocusWindow();
    // If there is a saved pair, silently restore the runner (resident regardless of login/window).
    void controller.startFromStore().catch((e) => console.error(`Runner restore failed: ${e}`));
    // Auto-update — one check at startup + every 6 hours (no-op if no feed configured, status disabled).
    updater.start();
  });

  // Do not quit when all windows close — resident in the tray (the runner runs in the background).
  app.on("window-all-closed", () => {
    /* resident in the tray */
  });
  app.on("activate", () => createOrFocusWindow()); // macOS dock click
  // Quit — gracefully stop the runner through reporting the in-flight job (preventDefault once, then re-quit).
  app.on("before-quit", (event) => {
    quitting = true;
    if (shuttingDown) return;
    shuttingDown = true;
    event.preventDefault();
    void controller.shutdown().finally(() => app.quit());
  });
}
