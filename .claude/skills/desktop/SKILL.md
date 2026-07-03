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
1. The window loads **only** the configured web origin (`ASSAY_WEB_URL`); any other navigation /
   `window.open` → `shell.openExternal` (system browser) and `event.preventDefault()`.
2. `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` — always.
3. The bridge is **exactly** `pairRunner` / `runnerStatus` (+ status events) / `unpairRunner` /
   `appInfo`. No generic `invoke`, no fs/shell exposure. New methods need a locked design decision.
4. Preload is attached only when loading the configured web origin; IPC handlers verify
   `senderFrame` origin before acting.
5. The `rnr_` pairing token is persisted **only** `safeStorage`-encrypted under `app.getPath("userData")`;
   never logged, never returned to the renderer (`pairRunner` is write-down-only).
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
  (gates must not download OS artifacts). Local dev: `pnpm -F @assay/desktop dev`
  (`ASSAY_WEB_URL=http://localhost:3000` against a dev web).

## Checklist
1. Read `docs/architecture/desktop-app.md` first; slice order is binding.
2. Any new persisted secret → `safeStorage`; any new window → same webPreferences invariants.
3. Runner behavior changes go in `runner-core` (so CLI + desktop stay identical), never forked in main.
4. Gates: `pnpm format`(scoped) → `lint` → `typecheck` → `test` → `build` all green before commit.
