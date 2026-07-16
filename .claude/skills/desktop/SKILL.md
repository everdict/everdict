---
name: desktop
description: Electron desktop shell (apps/desktop) — renders the deployed web, origin-gated bridge, embedded self-hosted runner via packages/self-hosted-runner. Use when editing apps/desktop, packages/self-hosted-runner, or desktop-aware branches in apps/web.
allowed-tools: Read, Grep, Glob, Edit, Write, Bash
---
# Desktop (Electron shell + self-hosted-runner)

Design SSOT: `docs/architecture/desktop-app.md` (D1–D5 locked). One sentence: the desktop renders the
**deployed `apps/web`** in a BrowserWindow (full web parity by construction) and embeds the
**self-hosted runner** (`packages/self-hosted-runner`) in the main process, paired one-click from the
logged-in web session over a minimal preload bridge.

## Process model
- **main** (Node, ESM, `type: module`) — window/tray/autostart/updater, keychain (`safeStorage`),
  `RunnerHost` (self-hosted-runner), IPC handlers. All Electron access lives here.
- **preload** (compiled to `.cjs`, sandboxed) — `contextBridge.exposeInMainWorld("everdictDesktop", …)`
  wrapping `ipcRenderer.invoke`. Nothing else.
- **renderer** — the *remote* web app. We ship **zero renderer code**; desktop-aware UI is a
  `window.everdictDesktop`-conditional branch inside `apps/web` (type it via a local `.d.ts` in web's
  `shared/` — the web must NOT gain `@everdict/*` deps).

## Security invariants (non-negotiable; changing any = update the SSOT doc + this skill in the same PR)
1. The window is pinned to the configured web app (`EVERDICT_WEB_URL`). Top-level navigation is allowed
   for http/https only — OIDC (Keycloak) login is a redirect flow that leaves and
   re-enters the web origin; blocking it breaks login. All other schemes are `preventDefault()`ed.
   `window.open`: web origin → in-app child window (same webPreferences); other http/https →
   `shell.openExternal`; anything else denied. Local power is never guarded by navigation policy —
   only by the IPC-layer origin check (invariant 4).
2. `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` — always.
3. The runner bridge is **exactly** `pairRunner` / `runnerStatus` (+ status events) / `unpairRunner` /
   `appInfo`. No generic `invoke`, no fs/shell exposure. New methods need a locked design decision.
   One sibling namespace rides on `everdictDesktop` (D10 — custom frameless title bar): `window` =
   `minimize`/`toggleMaximize`/`close`/`isMaximized`/`onMaximizeChange`, registered by `registerWindowChrome`
   (`window-chrome.ts`) — kept **separate** from the runner bridge (distinct concern; it needs the *sending* window)
   but under the SAME `senderFrame` origin gate. Benign window management only (no fs/shell/Node power); `close` = hide
   to tray (runner stays resident). The OS window is frameless (`frame:false` on Win/Linux; `titleBarStyle:"hidden"` +
   inset traffic lights on macOS) and the bar is drawn in `apps/web` (`widgets/desktop-titlebar`, gated on `window`
   being present so an older native-frame desktop shows no double bar). Any OTHER new method still needs a locked decision.
   The four runner methods are **multi-runner** (D9 — a device hosts several runners via `RunnerSupervisor`):
   `pairRunner({token, runnerId?, apiUrl?})` is **additive** (each call adds one runner, keyed by `runnerId`);
   `runnerStatus()`/its event return the aggregate `{ runners: DesktopRunnerStatus[] }` (a new web must **normalize**
   an older desktop's bare `DesktopRunnerStatus`); `unpairRunner(runnerId?)` drops one runner or (omitted) all;
   `appInfo()` includes `cpuCount` (the soft-cap reference). Tokens persist as an encrypted map
   (`runner-tokens.bin`, `{runnerId: rnr_token}`) + `config.runners[]`, never a single file.
   Two separate local-file surfaces exist (NOT web-origin bridges — trusted local pages, each behind its own
   argv flag, main-side IPC accepting only that page's exact `file://` senderFrame; never merge either into
   `everdictDesktop`): `window.everdictSetup` (D8 — `getServerUrl`/`setServerUrl`, `--everdict-setup`, the
   setup window) and `window.everdictTray` (D11 — the custom tray popover that replaces the unstylable native
   menu: `getState`/`onState`/`action`/`resize`/`hide`, `--everdict-tray`; benign tray-menu actions only —
   `tray-popover.ts` is the tested pure half, `main.ts` owns the frameless window/positioning/IPC glue).
4. Preload is attached only when loading the configured web origin; IPC handlers verify
   `senderFrame` origin before acting.
5. The `rnr_` pairing token is persisted **only** `safeStorage`-encrypted under `app.getPath("userData")`;
   never logged, never returned to the renderer (`pairRunner` is write-down-only). Linux without a
   keyring: opt in to safeStorage's `basic_text` backend with a logged warning (VSCode-style fallback) —
   never write the token outside safeStorage.
6. The desktop holds no Keycloak access token — auth lives in the webview's cookie session (web BFF).

## Layering
- `packages/self-hosted-runner` — extracted runner loop (`runLeaseWorkers`, `ResilientMcpSession`,
  `mcpConnect`, `runLeasedJob`, `RunnerHost`). Deps: `@everdict/contracts` + `@everdict/agent` +
  `@everdict/topology` + `@everdict/trace` + MCP SDK. Consumers: `apps/cli` (thin flags wrapper),
  `apps/desktop`. It must stay GUI-free and transport-injectable (DI like `RunnerLoopDeps`).
- `apps/desktop` — deps: `@everdict/self-hosted-runner` + `electron` (+ `electron-builder` dev). It must NOT
  import `@everdict/api`, `@everdict/db`, or web code. Reverse imports are bugs.

## Tooling
- Root **Biome applies** (unlike `apps/web` — no Next/eslint ecosystem here). Plain `tsc` build:
  main → ESM `dist/`, preload → separate `tsconfig.preload.json` emitting CommonJS `dist/preload.cjs`.
- Tests: Vitest on main-process **logic** with Electron injected as a dep (never `import "electron"`
  in a unit under test — pass `{ openExternal, safeStorage, … }` in, mirror `RunnerLoopDeps` style).
- Packaging (`electron-builder`) is a separate `package` script, **not** part of turbo `build`
  (gates must not download OS artifacts). It bundles main/preload to single files first
  (`esbuild.mjs`, `electron` external) so pnpm's symlinked `node_modules` never enters the asar;
  the packaged entry is swapped via `extraMetadata.main` (dev keeps `dist/main.js`). Keep
  `linux.executableName` path-safe (the package name `@everdict/desktop` is not). Local dev:
  `pnpm -F @everdict/desktop dev` (`EVERDICT_WEB_URL=http://localhost:3000` against a dev web).
- Releases ship from CI only: push tag `desktop-vX.Y.Z` → `.github/workflows/desktop-release.yml`
  builds the 3-OS matrix and publishes one GitHub Release (manual dispatch → draft). The version in
  `apps/desktop/package.json` stays `0.0.0` — CI injects the tag version at build time; do NOT bump
  it in commits. deb metadata requires `author` (with email) + `homepage` in package.json — keep them.
- Auto-update (D6): all logic goes through `UpdaterController` (`updater.ts`, DI — tests never import
  electron-updater). Detect/download automatic. On ready → a **prominent modal dialog** (main.ts
  `promptUpdateDialog`, not a tray-only nudge — users got stranded on old versions). "Later" re-prompts
  hourly AND **auto-applies once every runner is idle** (`totalActiveJobs === 0`, hooked in the status
  broadcast) — never kill a running case. Apply = set `quitting`+`shuttingDown` before `quitAndInstall`
  (else before-quit's preventDefault cancels the install). On startup, purge the web cache when
  `app.getVersion() !== config.lastVersion` (a just-updated binary must not render stale web UI). Activation
  gate lives in `resolveAutoUpdater()` (main.ts): packaged `app-update.yml` (shipped by electron-builder.yml's
  `publish` block) or `EVERDICT_UPDATE_FEED_URL` → userData config via `updateConfigPath` (`setFeedURL` alone
  breaks at download). **Feed = the PUBLIC `everdict/everdict` GitHub Releases** (`publish` block is present;
  ship via a `desktop-v*` tag). **Linux non-AppImage (deb/rpm)** can't swap in place → `autoDownload:false`
  (detect-only) + an `onAvailable` "Download" dialog opening the releases page.

## Checklist
1. Read `docs/architecture/desktop-app.md` first; slice order is binding.
2. Any new persisted secret → `safeStorage`; any new window → same webPreferences invariants.
3. Runner behavior changes go in `self-hosted-runner` (so CLI + desktop stay identical), never forked in main.
4. Gates: `pnpm format`(scoped) → `lint` → `typecheck` → `test` → `build` all green before commit.
