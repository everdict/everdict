---
name: desktop
description: Electron desktop shell (apps/desktop) — renders the deployed web, origin-gated bridge, embedded self-hosted runner via packages/runner-core. Use when editing apps/desktop, packages/runner-core, or desktop-aware branches in apps/web.
allowed-tools: Read, Grep, Glob, Edit, Write, Bash
---
# Desktop (Electron shell + runner-core)

Design SSOT: `docs/architecture/desktop-app.md` (D1–D5 locked). One sentence: the desktop renders the
**deployed `apps/web`** in a BrowserWindow (full web parity by construction) and embeds the
**self-hosted runner** (`packages/runner-core`) in the main process, paired one-click from the
logged-in web session over a minimal preload bridge.

## Process model
- **main** (Node, ESM, `type: module`) — window/tray/autostart/updater, keychain (`safeStorage`),
  `RunnerHost` (runner-core), IPC handlers. All Electron access lives here.
- **preload** (compiled to `.cjs`, sandboxed) — `contextBridge.exposeInMainWorld("assayDesktop", …)`
  wrapping `ipcRenderer.invoke`. Nothing else.
- **renderer** — the *remote* web app. We ship **zero renderer code**; desktop-aware UI is a
  `window.assayDesktop`-conditional branch inside `apps/web` (type it via a local `.d.ts` in web's
  `shared/` — the web must NOT gain `@assay/*` deps).

## Security invariants (non-negotiable; changing any = update the SSOT doc + this skill in the same PR)
1. The window is pinned to the configured web app (`ASSAY_WEB_URL`). Top-level navigation is allowed
   for http/https only — OIDC (Keycloak) and connected-accounts OAuth are redirect flows that leave and
   re-enter the web origin; blocking them breaks login. All other schemes are `preventDefault()`ed.
   `window.open`: web origin → in-app child window (same webPreferences); other http/https →
   `shell.openExternal`; anything else denied. Local power is never guarded by navigation policy —
   only by the IPC-layer origin check (invariant 4).
2. `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` — always.
3. The bridge is **exactly** `pairRunner` / `runnerStatus` (+ status events) / `unpairRunner` /
   `appInfo`. No generic `invoke`, no fs/shell exposure. New methods need a locked design decision.
4. Preload is attached only when loading the configured web origin; IPC handlers verify
   `senderFrame` origin before acting.
5. The `rnr_` pairing token is persisted **only** `safeStorage`-encrypted under `app.getPath("userData")`;
   never logged, never returned to the renderer (`pairRunner` is write-down-only). Linux without a
   keyring: opt in to safeStorage's `basic_text` backend with a logged warning (VSCode-style fallback) —
   never write the token outside safeStorage.
6. The desktop holds no Keycloak access token — auth lives in the webview's cookie session (web BFF).

## Layering
- `packages/runner-core` — extracted runner loop (`runLeaseWorkers`, `ResilientMcpSession`,
  `mcpConnect`, `runLeasedJob`, `RunnerHost`). Deps: `@assay/core` + `@assay/agent` +
  `@assay/topology` + `@assay/trace` + MCP SDK. Consumers: `apps/cli` (thin flags wrapper),
  `apps/desktop`. It must stay GUI-free and transport-injectable (DI like `RunnerLoopDeps`).
- `apps/desktop` — deps: `@assay/runner-core` + `electron` (+ `electron-builder` dev). It must NOT
  import `@assay/api`, `@assay/db`, or web code. Reverse imports are bugs.

## Tooling
- Root **Biome applies** (unlike `apps/web` — no Next/eslint ecosystem here). Plain `tsc` build:
  main → ESM `dist/`, preload → separate `tsconfig.preload.json` emitting CommonJS `dist/preload.cjs`.
- Tests: Vitest on main-process **logic** with Electron injected as a dep (never `import "electron"`
  in a unit under test — pass `{ openExternal, safeStorage, … }` in, mirror `RunnerLoopDeps` style).
- Packaging (`electron-builder`) is a separate `package` script, **not** part of turbo `build`
  (gates must not download OS artifacts). It bundles main/preload to single files first
  (`esbuild.mjs`, `electron` external) so pnpm's symlinked `node_modules` never enters the asar;
  the packaged entry is swapped via `extraMetadata.main` (dev keeps `dist/main.js`). Keep
  `linux.executableName` path-safe (the package name `@assay/desktop` is not). Local dev:
  `pnpm -F @assay/desktop dev` (`ASSAY_WEB_URL=http://localhost:3000` against a dev web).
- Releases ship from CI only: push tag `desktop-vX.Y.Z` → `.github/workflows/desktop-release.yml`
  builds the 3-OS matrix and publishes one GitHub Release (manual dispatch → draft). The version in
  `apps/desktop/package.json` stays `0.0.0` — CI injects the tag version at build time; do NOT bump
  it in commits. deb metadata requires `author` (with email) + `homepage` in package.json — keep them.

## Checklist
1. Read `docs/architecture/desktop-app.md` first; slice order is binding.
2. Any new persisted secret → `safeStorage`; any new window → same webPreferences invariants.
3. Runner behavior changes go in `runner-core` (so CLI + desktop stay identical), never forked in main.
4. Gates: `pnpm format`(scoped) → `lint` → `typecheck` → `test` → `build` all green before commit.
