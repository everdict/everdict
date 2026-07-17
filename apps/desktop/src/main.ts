import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, hostname } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ResilientMcpSession, RunnerHost, detectCapabilities, mcpConnect } from "@everdict/self-hosted-runner";
import {
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  app,
  dialog,
  ipcMain,
  nativeImage,
  safeStorage,
  screen,
  session,
  shell,
} from "electron";
import electronUpdater from "electron-updater";
import {
  BRIDGE_CHANNELS,
  type DesktopAppInfo,
  type DesktopRunnersStatus,
  registerBridge,
  senderAllowed,
} from "./bridge.js";
import { type ConfigIo, type DesktopConfig, loadConfig, saveConfig } from "./config-store.js";
import { NotificationWatcher, type WatcherNotification } from "./notification-watcher.js";
import { RunnerSupervisor } from "./runner-supervisor.js";
import { normalizeWebUrl, resolveWebUrl } from "./server-url.js";
import { type TokenIo, clearToken, loadToken, loadTokens, saveTokens } from "./token-store.js";
import { type TrayMenuActions, type TrayMenuState, buildTrayMenuTemplate, runnerStatusLabel } from "./tray-menu.js";
import {
  TRAY_CHANNELS,
  type TrayAction,
  buildTrayPopoverViewModel,
  popoverPosition,
  registerTrayBridge,
} from "./tray-popover.js";
import { type AutoUpdaterLike, UpdaterController, type UpdaterState } from "./updater.js";
import { WINDOW_CHANNELS, registerWindowChrome } from "./window-chrome.js";
import { allowTopLevelNavigation, decideWindowOpen, shouldRecoverToSetup, webOriginOf } from "./window-policy.js";
import { registerZoomShortcuts } from "./zoom.js";

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

// Frameless custom title bar (D10) — the web draws the whole bar (brand · drag · window controls) via
// window.everdictDesktop.window. Windows/Linux → fully frameless (the web draws minimize/maximize/close). macOS →
// keep the native traffic lights (Mac users expect them + they survive a web-bar failure) but hide the bar and inset
// the lights so they sit centered in our ~36px bar; the web draws the rest. The setup window keeps its native frame.
function titleBarPreferences(): Pick<
  Electron.BrowserWindowConstructorOptions,
  "frame" | "titleBarStyle" | "trafficLightPosition"
> {
  if (process.platform === "darwin") return { titleBarStyle: "hidden", trafficLightPosition: { x: 14, y: 11 } };
  return { frame: false };
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
// Custom tray popover (D11) — a frameless, transparent window rendering assets/tray-popover.html, replacing the native
// tray menu whose text the OS theme rendered unreadable. Pre-created hidden so the first open is instant + already measured.
let popoverWindow: BrowserWindow | null = null;
let popoverContentHeight = 232; // the renderer reports its measured height; this is only the pre-measure default
let popoverHiddenAt = 0; // guards the tray-click-right-after-blur reopen race (blur hides first, then the click would re-show)
const POPOVER_WIDTH = 288;
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

// safeStorage ciphertext file IO helper — token-store handles encrypt/decrypt.
function binIo(fileName: string): TokenIo {
  const dir = app.getPath("userData");
  const file = path.join(dir, fileName);
  return {
    read: () => (existsSync(file) ? readFileSync(file) : null),
    write: (data) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, data);
    },
    remove: () => rmSync(file, { force: true }),
  };
}
// The multi-runner token map (D9) — { runnerId: rnr_token } encrypted at rest.
function tokensIo(): TokenIo {
  return binIo("runner-tokens.bin");
}
// Legacy single-runner token file (pre-D9) — read once to migrate an older desktop's pairing, then removed.
function legacyTokenIo(): TokenIo {
  return binIo("runner-token.bin");
}

let config: DesktopConfig;

function applyAutostart(next: boolean): void {
  config = { ...config, autostart: next };
  saveConfig(configIo(), config);
  // macOS/Windows only (Electron no-ops on Linux) — supplemented by a .desktop autostart in the packaging slice.
  app.setLoginItemSettings({ openAtLogin: next });
  refreshTrayMenu();
}

// Latest aggregate runner status (every runner on this device, D9) referenced by the tray/notifications — updated by broadcast.
let latestRunnersStatus: DesktopRunnersStatus = { runners: [] };
// Counters for the drain (running→idle) notification — notifying per case would spam in a batch. Aggregated across all runners.
let doneSinceIdle = 0;
let failedSinceIdle = 0;

// Total in-flight jobs across every runner on this device — the basis for the aggregate running/idle transition.
function totalActiveJobs(status: DesktopRunnersStatus): number {
  return status.runners.reduce((sum, r) => sum + r.activeJobs, 0);
}

// One notification when the device drains (any-running → none-running), tallying success/failure — the local counterpart of the Mattermost completion notification.
function notifyDrainIfNeeded(prev: DesktopRunnersStatus, next: DesktopRunnersStatus): void {
  const wasRunning = totalActiveJobs(prev) > 0;
  const stillRunning = totalActiveJobs(next) > 0;
  if (!wasRunning || stillRunning || doneSinceIdle + failedSinceIdle === 0) return;
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
  // The notification feed is per-subject; every runner on this device belongs to the signed-in account, so one watcher (any
  // runner's token) covers them all. Use the first paired runner's token + its control-plane URL.
  const token = Object.values(loadTokens(safeStorage, tokensIo()))[0];
  if (token === undefined) return;
  const conf = loadConfig(configIo());
  const apiUrl = conf.runners[0]?.apiUrl ?? conf.apiUrl ?? defaultApiUrl;
  const session = new ResilientMcpSession(mcpConnect(new URL("/mcp", apiUrl), token));
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

// Runner supervisor — persists pair state (token map + config roster) + drives one RunnerHost per paired runner (D9: multiple runners
// on this device). Status is pushed only to web-origin windows (the same boundary as invariant 4).
const supervisor = new RunnerSupervisor({
  loadTokens: () => loadTokens(safeStorage, tokensIo()),
  saveTokens: (tokens) => saveTokens(safeStorage, tokensIo(), tokens),
  clearTokens: () => clearToken(tokensIo()),
  loadRunners: () => loadConfig(configIo()).runners,
  saveRunners: (runners) => {
    // Persist the roster; drop the legacy single-runner scalars once they have been migrated into it.
    const { runnerId: _r, apiUrl: _a, ...rest } = loadConfig(configIo());
    config = { ...rest, runners };
    saveConfig(configIo(), config);
  },
  loadLegacy: () => {
    const token = loadToken(safeStorage, legacyTokenIo());
    if (token === null) return null;
    const c = loadConfig(configIo());
    return {
      token,
      ...(c.runnerId !== undefined ? { runnerId: c.runnerId } : {}),
      ...(c.apiUrl !== undefined ? { apiUrl: c.apiUrl } : {}),
    };
  },
  clearLegacy: () => clearToken(legacyTokenIo()),
  makeHost: ({ token, apiUrl, onStatus, maxConcurrent }) =>
    new RunnerHost({
      token,
      apiUrl,
      onStatus,
      // Per-runner concurrency chosen at pair time (desktop-local) → runLeaseWorkers spins this many worker loops. Unset → RunnerHost default of 1.
      ...(maxConcurrent !== undefined ? { maxConcurrent } : {}),
      os: process.platform, // self-reported OS → the roster fills in the OS with no user input
      // Self-report this app's version on every lease → the control plane derives the roster's update-required badge.
      version: app.getVersion(),
      onJobDone: (done) => {
        if (done.error) failedSinceIdle++;
        else doneSinceIdle++;
      },
      // The control plane reported this runner is behind the server → force an immediate auto-update check so a desktop
      // user (who can't otherwise tell) self-updates instead of silently failing jobs, rather than waiting up to 6h.
      onUpdateRequired: (info) => {
        console.error(
          `Runner is behind the control plane (server protocol ${info.serverProtocol ?? "?"}) — checking for an update now.`,
        );
        updater.checkNow();
      },
      log: (m) => console.error(m),
      // Desktop uses a shorter long-poll than the CLI (25s) to reduce shutdown latency (stop waits for the current poll to complete).
      waitMs: 8_000,
    }),
  defaultApiUrl,
  broadcast: (status) => {
    notifyDrainIfNeeded(latestRunnersStatus, status);
    latestRunnersStatus = status;
    // Independent notifications (N6): watch while ≥1 runner is paired, stop at zero — the feed flows regardless of any web session.
    if (status.runners.length > 0) startNotifyWatcher();
    else stopNotifyWatcher();
    maybeApplyOnIdle(); // a deferred update applies the moment the last runner job finishes (never mid-job)
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

// Non-AppImage Linux (deb/rpm) can't be swapped in place by electron-updater → detect-only + a manual-download prompt.
const canApplyInPlace = !(process.platform === "linux" && !process.env.APPIMAGE);
const RELEASES_URL = "https://github.com/everdict/everdict/releases/latest";

let updaterState: UpdaterState = { kind: "disabled" };
const updater = new UpdaterController({
  updater: resolveAutoUpdater(),
  autoDownload: canApplyInPlace,
  // deb/rpm: no in-place apply — point the user at the download page instead of silently doing nothing.
  onAvailable: (version) => {
    if (!canApplyInPlace) void promptManualDownload(version);
  },
  onStatus: (state) => {
    const prev = updaterState;
    updaterState = state;
    if (state.kind !== prev.kind)
      console.error(`Update status: ${state.kind}${"version" in state ? ` v${state.version}` : ""}`);
    refreshTrayMenu();
    if (state.kind === "ready" && prev.kind !== "ready") void onUpdateReady(state.version);
  },
  log: (m) => console.error(m),
});

// Apply the update — gracefully clean up the runner, then restart and install. Set the flags first so it does not take
// the before-quit preventDefault path (so the install is not canceled midway).
function applyUpdateNow(): void {
  quitting = true;
  shuttingDown = true;
  void supervisor
    .shutdown()
    .catch(() => {})
    .finally(() => updater.quitAndInstall());
}

// --- D6 auto-update UX: a prominent dialog + apply-when-idle (never abort a running case) ---
// A ready update is easy to miss when it only lives in the tray, so users get stranded on an old version (which then
// can't reach the newer control plane). Policy: on ready, show a modal dialog; if deferred, keep it applied by (a) a
// periodic re-prompt and (b) auto-applying once every runner on this device is idle — a running job is never killed.
let readyVersion: string | null = null;
let updateDeferred = false;
let repromptTimer: ReturnType<typeof setInterval> | null = null;
const REPROMPT_MS = 60 * 60 * 1000; // re-nudge a deferred update hourly

async function onUpdateReady(version: string): Promise<void> {
  readyVersion = version;
  updateDeferred = false;
  await promptUpdateDialog(version);
}

// The prominent consent dialog. "Update now" applies immediately; "Later" defers to the idle/quit/re-prompt paths.
async function promptUpdateDialog(version: string): Promise<void> {
  const busy = totalActiveJobs(latestRunnersStatus) > 0;
  const opts: Electron.MessageBoxOptions = {
    type: "info",
    title: "Everdict update ready",
    message: `Everdict v${version} is ready to install.`,
    detail: busy
      ? "Restarting updates the app. A runner is currently working — choose Later and it will update automatically once the runner is idle (or apply now to stop the job and update)."
      : "Restart now to update. If you choose Later, it will apply the next time the app is idle or on quit.",
    buttons: ["Update now", "Later"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };
  const win = mainWindow;
  const { response } = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
  if (response === 0) {
    applyUpdateNow();
    return;
  }
  updateDeferred = true;
  if (!repromptTimer) {
    repromptTimer = setInterval(() => {
      if (readyVersion && updateDeferred) void promptUpdateDialog(readyVersion);
    }, REPROMPT_MS);
    (repromptTimer as { unref?: () => void }).unref?.();
  }
  maybeApplyOnIdle(); // it may already be idle
}

// Deb/rpm manual path — electron-updater can't swap the package in place, so open the release download.
async function promptManualDownload(version: string): Promise<void> {
  const win = mainWindow;
  const opts: Electron.MessageBoxOptions = {
    type: "info",
    title: "Everdict update available",
    message: `Everdict v${version} is available.`,
    detail: "This install type updates from the download page (the in-app auto-update needs the AppImage build).",
    buttons: ["Download", "Later"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };
  const { response } = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
  if (response === 0) void shell.openExternal(RELEASES_URL);
}

// Called on every runner-status change: if an update is downloaded + deferred and no runner is working, apply it.
function maybeApplyOnIdle(): void {
  if (readyVersion && updateDeferred && totalActiveJobs(latestRunnersStatus) === 0) {
    updateDeferred = false;
    applyUpdateNow();
  }
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
    // Soft-cap reference (D9): the web warns when the user pairs more runners on this device than there are logical cores.
    cpuCount: cpus().length,
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
    ...titleBarPreferences(),
    webPreferences: securePreferences(origin),
  });
  // Frameless custom title bar (D10): tell the web when the maximized state changes so it can toggle the maximize/restore
  // glyph. Same origin boundary as the status broadcast — only push to a frame still on the web origin.
  const pushMaximizeState = (): void => {
    if (senderAllowed(win.webContents.getURL(), origin))
      win.webContents.send(WINDOW_CHANNELS.maximizeEvent, win.isMaximized());
  };
  win.on("maximize", pushMaximizeState);
  win.on("unmaximize", pushMaximizeState);
  // Ctrl/Cmd +/−/0 page zoom (D10 frameless windows have no menu bar, and the default menu's zoom-in accelerator
  // never matches Ctrl+= on common layouts — see zoom.ts). Cover the in-app child windows opened via window.open too.
  registerZoomShortcuts(win.webContents);
  win.webContents.on("did-create-window", (child) => registerZoomShortcuts(child.webContents));
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
    return {
      action: "allow",
      overrideBrowserWindowOptions: { ...titleBarPreferences(), webPreferences: securePreferences(origin) },
    };
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

// The current tray/popover state snapshot — shared by the native menu (Linux fallback), the popover view model, and the tooltip.
function currentTrayState(): TrayMenuState {
  return { autostart: config.autostart, runner: latestRunnersStatus, updater: updaterState };
}

// The tray/popover actions — one set shared by the native menu items (Linux) and the popover bridge (macOS/Windows).
// The styled popover is reached only by the tray click on macOS/Windows (`toggleTrayPopover`); the Linux native menu has no
// launcher item, so it does not open the popover — the menu itself is the full tray UI there.
function trayActions(): TrayMenuActions {
  return {
    openApp: () => createOrFocusWindow(),
    setAutostart: (next) => applyAutostart(next),
    changeServerUrl: () => openSetupWindow(),
    // Reconnect-all — force every runner on this device to reopen its session and resume leasing (recovers an offline runner).
    reconnectRunner: () => void supervisor.reconnect().catch((e) => console.error(`Runner reconnect failed: ${e}`)),
    // Local unpair-all (discard the tokens + stop) — the web account page is authoritative for revoking the server records.
    unpairRunner: () => void supervisor.unpair().catch((e) => console.error(`Runner unpair failed: ${e}`)),
    applyUpdate: () => applyUpdateNow(),
    quit: () => {
      quitting = true;
      app.quit();
    },
  };
}

function trayPopoverPageUrl(): string {
  return pathToFileURL(path.join(app.getAppPath(), "assets", "tray-popover.html")).toString();
}

// Lazily create (once) the frameless/transparent popover window. Loaded hidden and kept resident so opening is instant and
// the height is already measured. Dismisses on blur (menu semantics). Its bridge is --everdict-tray, file-URL gated by main.
function ensurePopoverWindow(): BrowserWindow {
  if (popoverWindow && !popoverWindow.isDestroyed()) return popoverWindow;
  const win = new BrowserWindow({
    width: POPOVER_WIDTH,
    height: popoverContentHeight,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(import.meta.dirname, "preload.cjs"),
      additionalArguments: ["--everdict-tray"],
    },
  });
  win.setMenuBarVisibility(false);
  // Click-away dismiss. Record the hide time so a tray click that immediately follows (the blur fires first) is treated as
  // "close", not "open again" (see toggleTrayPopover).
  win.on("blur", () => {
    if (win.isDestroyed() || !win.isVisible()) return;
    popoverHiddenAt = Date.now();
    win.hide();
  });
  win.on("closed", () => {
    popoverWindow = null;
  });
  void win.loadURL(trayPopoverPageUrl());
  popoverWindow = win;
  return win;
}

// Anchor the popover to the tray icon on the display under the cursor, sized to the last measured content height.
function placePopover(win: BrowserWindow, display: Electron.Display): void {
  const bounds = tray?.getBounds() ?? { x: 0, y: 0, width: 0, height: 0 };
  const { x, y } = popoverPosition({
    tray: bounds,
    size: { width: POPOVER_WIDTH, height: popoverContentHeight },
    workArea: display.workArea,
  });
  win.setBounds({ x, y, width: POPOVER_WIDTH, height: popoverContentHeight });
}

function showTrayPopover(): void {
  const win = ensurePopoverWindow();
  placePopover(win, screen.getDisplayNearestPoint(screen.getCursorScreenPoint()));
  win.show();
  win.focus();
}

// Tray click (macOS/Windows) — toggle. If the window is visible, hide it; if a click lands right after a click-away blur
// (which already hid it), treat that as the toggle-off and do not reopen.
function toggleTrayPopover(): void {
  const win = ensurePopoverWindow();
  if (win.isVisible()) {
    win.hide();
    return;
  }
  if (Date.now() - popoverHiddenAt < 250) return;
  showTrayPopover();
}

function dispatchTrayAction(action: TrayAction): void {
  switch (action.type) {
    case "openApp":
      createOrFocusWindow();
      break;
    case "setAutostart":
      applyAutostart(action.value);
      break;
    case "changeServer":
      openSetupWindow();
      break;
    case "reconnect":
      void supervisor.reconnect().catch((e) => console.error(`Runner reconnect failed: ${e}`));
      break;
    case "unpair":
      void supervisor.unpair().catch((e) => console.error(`Runner unpair failed: ${e}`));
      break;
    case "applyUpdate":
      applyUpdateNow();
      break;
    case "quit":
      quitting = true;
      app.quit();
      break;
  }
}

// Push a fresh view model to the popover so it updates live while open (runner status, autostart, update state).
function pushTrayState(): void {
  const win = popoverWindow;
  if (win && !win.isDestroyed())
    win.webContents.send(TRAY_CHANNELS.stateEvent, buildTrayPopoverViewModel(currentTrayState()));
}

// The renderer reports its content height → size the frameless window to fit; if it is open, re-anchor to keep it in place.
function setPopoverContentHeight(height: number): void {
  popoverContentHeight = height;
  const win = popoverWindow;
  if (win && !win.isDestroyed() && win.isVisible()) placePopover(win, screen.getDisplayMatching(win.getBounds()));
}

function refreshTrayMenu(): void {
  if (!tray) return;
  tray.setToolTip(`Everdict — ${runnerStatusLabel(latestRunnersStatus)}`);
  // Linux: the AppIndicator swallows tray clicks and requires a context menu, so keep the native menu (its top item opens
  // the readable popover, D11). macOS/Windows: the tray click opens the popover directly — no native menu is set.
  if (process.platform === "linux")
    tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate(currentTrayState(), trayActions())));
  pushTrayState();
}

function createTray(): void {
  const icon = nativeImage.createFromPath(path.join(app.getAppPath(), "assets", "tray.png"));
  tray = new Tray(icon);
  // macOS/Windows emit tray click events → open the rich popover directly. On Linux the click is swallowed by the
  // AppIndicator (only the context menu shows), so there the popover is reached from the native menu's launcher item.
  if (process.platform !== "linux") {
    tray.on("click", () => toggleTrayPopover());
    tray.on("right-click", () => toggleTrayPopover());
  }
  ensurePopoverWindow(); // pre-load hidden so the first open is instant and already sized
  refreshTrayMenu();
}

// Single instance — a second launch brings the existing window to the front.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => createOrFocusWindow());

  void app.whenReady().then(async () => {
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
    // D6 auto-update robustness: if the binary version changed since last run (= just updated), purge the web cache
    // BEFORE loading so the updated shell always renders current web content — the stale-cache class of bug that made an
    // updated app still look like the old one. Awaited so the first load is clean; packaged-only (dev reloads anyway).
    if (app.isPackaged) {
      const version = app.getVersion();
      if (config.lastVersion !== version) {
        console.error(`Version ${config.lastVersion ?? "?"} → ${version} — purging the web cache for a clean load.`);
        await session.defaultSession.clearCache().catch(() => {});
        await session.defaultSession.clearStorageData({ storages: ["cachestorage", "serviceworkers"] }).catch(() => {});
        config = { ...config, lastVersion: version };
        saveConfig(configIo(), config);
      }
    }
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
      pair: (payload) => supervisor.pair(payload),
      unpair: (runnerId) => supervisor.unpair(runnerId),
      reconnect: (runnerId) => supervisor.reconnect(runnerId),
      status: () => supervisor.status(),
    });
    // Frameless custom title bar (D10) — window controls act on the window that sent the call. Same origin gate as the
    // runner bridge (invariant 4); `close` routes through the window's close handler (= hide to tray, keeping the runner resident).
    registerWindowChrome(ipcMain, {
      webOrigin: () => webOrigin,
      windowForSender: (sender) => BrowserWindow.fromWebContents(sender as Electron.WebContents),
    });
    // Tray popover bridge (D11) — like the setup window (D8), the permission boundary is an exact local file:// match: only
    // the popover page's frame may drive it (never the web or an external page). Benign tray-menu actions only.
    const trayPageUrl = trayPopoverPageUrl();
    registerTrayBridge(ipcMain, {
      fromTrayPage: (frameUrl) => frameUrl === trayPageUrl,
      getState: () => currentTrayState(),
      performAction: (action) => dispatchTrayAction(action),
      setContentHeight: (height) => setPopoverContentHeight(height),
      hide: () => {
        if (popoverWindow && !popoverWindow.isDestroyed()) popoverWindow.hide();
      },
    });
    createTray();
    createOrFocusWindow();
    // If there are saved pairings, silently restore every runner (resident regardless of login/window).
    void supervisor.startFromStore().catch((e) => console.error(`Runner restore failed: ${e}`));
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
    void supervisor.shutdown().finally(() => app.quit());
  });
}
