# Desktop app — full web parity + resident self-hosted runner

> **Status: decisions D1–D5 LOCKED with the user (2026-07-03) — implementation in progress.**
> Supersedes the "tray-only companion" idea: the user requirement is **perform identically to the web via
> the desktop app too** — the desktop must do *everything the web does*, plus what only a native app can do (resident
> runner, one-click pairing, tray/notifications/autostart).
> Dev conventions for `apps/desktop` / `packages/self-hosted-runner` live in skill `.claude/skills/desktop/`.
> - **D6 — auto-update: detect/download automatic, APPLY is user-consented but not tray-buried (LOCKED); ENABLED.**
>   `electron-updater` in main behind `UpdaterController` (DI): check on launch + every 6h,
>   `autoDownload`, `autoInstallOnAppQuit`. On ready, main shows a **prominent modal dialog**
>   ("Update now / Later") — the tray-only prompt stranded users on an old version (which then can't reach a
>   newer control plane). "Later" is not a dead end: it **re-prompts hourly** and **auto-applies the moment
>   every runner on the device goes idle** (`totalActiveJobs === 0`), so a running case is never killed
>   (apply = graceful runner shutdown → `quitAndInstall`). On startup, if `app.getVersion()` differs from the
>   stored `config.lastVersion` (= the binary just updated) the **web session cache is purged**
>   (`clearCache` + `clearStorageData` for cachestorage/serviceworkers) BEFORE the first load, so an updated
>   shell never renders stale web UI. Activation gate: `app.isPackaged` && (packaged `app-update.yml` [shipped
>   by electron-builder's `publish` block] || `EVERDICT_UPDATE_FEED_URL` env → generic feed via a userData
>   config injected through `autoUpdater.updateConfigPath` — `setFeedURL` alone is insufficient: AppImageUpdater
>   reads the on-disk config during download). **Feed = GitHub Releases of the public `everdict/everdict` repo**
>   (`electron-builder.yml` `publish: {provider: github, owner: everdict, repo: everdict}`; public repo →
>   read without a token). Ship an update by pushing a `desktop-v*` tag (release workflow attaches the
>   installers + `latest*.yml`). mac auto-update stays inert until code signing exists. **Linux non-AppImage
>   (deb/rpm) can't be swapped in place** → `autoDownload:false` (detect-only) + an `onAvailable` "Download"
>   dialog that opens the releases page (AppImage/NSIS/mac-zip do apply in place).
> - **D7 — the desktop fully absorbs the pairing surface (LOCKED 2026-07-03).** The browser web no longer
>   offers manual device pairing (the token-shown-once modal is removed): personal-machine pairing is the
>   desktop's one-click only, and the browser account page becomes **manage-only** (list · live status ·
>   revoke) + a "Get the desktop app" CTA (`DESKTOP_DOWNLOAD_URL`). The server surface is unchanged —
>   `POST /runners` (BFF+MCP `pair_runner`) stays, which is also the **headless path**: on a server/CI box,
>   create the pairing with an API key (`curl -H "Authorization: Bearer ak_…" -X POST /runners`) and feed
>   the returned `rnr_` token to `everdict runner --pair`.
> - **D8 — the packaged app must know its server (LOCKED 2026-07-03).** Web URL resolution:
>   `EVERDICT_WEB_URL` env (dev/e2e) > `config.json webUrl` (user-saved) > CI-baked default
>   (`EVERDICT_DESKTOP_DEFAULT_WEB_URL` repo Variable → esbuild `define` at package time). None → a local
>   **first-run setup screen** (`assets/setup.html`) asks for the server address; also reachable from the
>   tray ("Change server address…"). The setup window gets its own 2-method bridge (`window.everdictSetup`:
>   get/setServerUrl) behind a `--everdict-setup` argv flag, and the main-side IPC only accepts calls whose
>   `senderFrame` is exactly the local setup.html `file://` URL. Changing the server rebuilds the app
>   window (old preload origin args are stale) and the runner bridge origin-guard reads the *current*
>   origin (getter, not a captured value). **Login/auth status**: with D8 in place the auth story is
>   closed — Keycloak OIDC runs inside the webview (D5, cookies persist like a browser), the runner
>   authenticates independently via its `rnr_` keychain token, and an account-switch mismatch shows a
>   re-pair callout on the account page. Live-verified end-to-end vs real Keycloak
>   (`scripts/live/desktop-keycloak.mjs`): fresh machine → setup screen → server saved → OIDC login
>   (alice) → one-click pair → runner online, against the real-auth control plane.
>   **Wrong-address recovery**: a mistyped/unreachable server would otherwise strand the app on a dead
>   error page, and the tray "Change server address…" is unreliable on Linux (no tray on some DEs). So the
>   pinned window's **initial top-level load failure** (`did-fail-load`, main-frame, not `ERR_ABORTED`, not
>   yet loaded — `shouldRecoverToSetup`) auto-opens the setup screen, and `createOrFocusWindow` routes to
>   setup while that failed state holds (reset when a fresh address is saved / the server loads). Recovery
>   no longer depends on the tray.
> - **D9 — one device, several runners (LOCKED 2026-07-15).** The desktop supervises *multiple* independent runner
>   registrations, not one. The server already models a personal `self` pool keyed by `(owner, runnerId)` — several
>   runners under one account simply widen that pool — so this is purely a client change. Each pairing is its own `rnr_`
>   identity; the account page's "Connect this device as a runner" becomes **additive** ("Connect another runner"), and
>   every runner is an independent row (own live status, own revoke). Per-runner concurrency stays 1 (`maxConcurrent`
>   unchanged) — **adding runners is how a user widens their pool**; the scorecard's own concurrency drives parallelism.
>   Resource guard = **soft cap + warning**: the bridge reports `appInfo().cpuCount` and the web warns once this device
>   hosts ≥ cores runners, but never blocks (the user opts in). Persistence moves from a single `runner-token.bin` +
>   scalar config meta to an encrypted **token map** (`runner-tokens.bin`, `{ runnerId: rnr_token }`) + a config
>   **`runners[]`** roster; an older desktop's single pairing is **migrated once** on startup. The bridge shape grows to
>   match (invariant 3): `runnerStatus()` returns `{ runners: DesktopRunnerStatus[] }`, `unpairRunner(runnerId?)` takes an
>   optional id (omitted = all), `pairRunner` is additive, `appInfo()` gains `cpuCount`. A newly-deployed web stays
>   version-skew tolerant against a not-yet-updated desktop by **normalizing** a bare `DesktopRunnerStatus` into the list.
>
> - **D10 — custom frameless title bar, not the native chrome (LOCKED 2026-07-15).** The native OS window buttons
>   (minimize/maximize/close) read as legacy and off-brand, so the desktop goes **frameless** and the web draws its own
>   theme-aware title bar. Platform split: **Windows/Linux** → `frame: false` (the web draws all three buttons);
>   **macOS** → `titleBarStyle: "hidden"` + inset traffic lights (Mac users expect them, and they survive a web-bar
>   failure), the web draws the rest. Because the renderer is the *remote* web (D1), the bar lives in `apps/web` as a
>   `window.everdictDesktop.window`-gated branch (`widgets/desktop-titlebar`, styled with the app's own theme tokens so
>   it matches light+dark) — it renders **only** when the bridge exposes `window`, so an older native-frame desktop shows
>   **no** bar (no double title bar); the residual skew is that the frameless-window change and the web title-bar slice
>   must ship together (the tray remains the safety net for quit either way). The bridge grows to match (invariant 3) with
>   a window-chrome surface `everdictDesktop.window = { minimize, toggleMaximize, close, isMaximized, onMaximizeChange }`
>   driven over origin-gated IPC (`registerWindowChrome`, kept **separate** from the runner bridge — a distinct concern
>   that needs the *sending* window — under the same `senderFrame` origin gate, invariant 4). `close` routes through the
>   window's close handler = **hide to tray** (the runner stays resident, unchanged). Content is offset below the fixed
>   bar by a scoped `globals.css` rule (`html.desktop-shell`, added by the widget on mount); the window is moved via
>   `-webkit-app-region: drag`. Window controls are **benign** — no fs/shell/Node power — so the security posture is unchanged.
>
> - **D11 — a custom tray popover, not the native menu (LOCKED 2026-07-16).** The native tray context menu
>   (`Menu.buildFromTemplate`) is OS-rendered and **unstylable** — on some Linux GTK themes its text sits at near-zero
>   contrast against the menu background (the reason this decision exists). So the tray menu becomes a **frameless,
>   transparent BrowserWindow** rendering a local page (`assets/tray-popover.html`) we style fully (Toss/Linear dark,
>   readable) with runner-status **reactions** (idle = a breathing dot, running = a pulse ring, job-done = a brief ✦ tick).
>   Trigger is platform-split: **macOS/Windows** emit a tray `click` → the click toggles the popover (no native menu is
>   set); **Linux** AppIndicator swallows the click and *requires* a context menu, so there the native menu is the
>   **complete tray UI** and the styled popover is **not surfaced** — an earlier "Open Everdict panel" launcher item was
>   dropped (2026-07-16) as a confusing duplicate of the menu it lived in (the native menu already carries every action).
>   The popover gets its **own
>   local-file bridge** `window.everdictTray` (`getState` / `onState` / `action` / `resize` / `hide`) behind a
>   `--everdict-tray` argv flag, gated **exactly like the setup window (D8)**: main-side IPC accepts only the popover's
>   `file://` senderFrame — never the web or an external page (`registerTrayBridge`). Actions are the same **benign** set
>   the menu had (open app · autostart · change server · reconnect [D12] · unpair · apply update · quit) — the token/keychain surfaces are
>   untouched, so the security posture is unchanged. The window is pre-created hidden (instant first open) and dismisses on
>   blur; main sizes the frameless window from the renderer's measured height and anchors it to the tray icon
>   (`popoverPosition`, top-right fallback when the OS reports no tray geometry). The pure half (`tray-popover.ts`: view
>   model · placement · action schema · bridge) is unit-tested; `main.ts` owns the window/screen/IPC glue.
> - **D12 — reactivate an offline runner without re-pairing (LOCKED 2026-07-16).** A runner is shown "offline" when the
>   control plane's `lastSeenAt` for it goes stale (>90s) — which happens when its lease loop can't reach the control plane
>   (network blip / API restart / a stuck long-poll) or its host stopped; an offline runner leases no work. The only prior
>   remedy was **revoke + re-pair** (heavy-handed, and the token is shown once). D12 adds a **reconnect** lever:
>   `RunnerHost.restart()` (graceful `stop()`→`start()`, so a fresh MCP session re-advertises capabilities and resumes
>   leasing → the next lease/heartbeat refreshes `lastSeenAt` → back online; in-flight jobs finish first),
>   `RunnerSupervisor.reconnect(runnerId?)` (restart a live host in place — no host swap, no status race — or (re)start a
>   token-present runner that has no live host, e.g. one skipped at startup after a keychain loss; a still-tokenless runner
>   is a no-op, it must be re-paired), and the bridge method `reconnectRunner(runnerId?)`. Surfaced two ways: the **web
>   runtimes page** (`RunnersManager`) turns each *this device* row's status into a status-icon **dropdown** with a
>   **Reconnect** action (state-controls convention; only *this device* holds the token, so only its desktop can reconnect),
>   and the **tray** (native menu + popover `reconnect` action) reconnects all runners on the device. Bridge-additive and
>   optional on the web mirror, so an older shell just doesn't show the affordance. No control-plane change — this is pure
>   local device control (the server already refreshes `lastSeenAt` on the resulting lease).
>
> - **D1 — the UI is the deployed web, not a rebuild.** The desktop shell renders the SaaS web
>   (`apps/web`) at its deployed URL inside the app window — the Linear/Slack/Notion model. `apps/web`
>   stays the **single UI SSOT**; the desktop has feature parity *by construction* (every web deploy
>   lands in the desktop instantly, no app release). We never fork or re-implement screens in the shell.
> - **D2 — shell is Electron (LOCKED).** Rationale: the monorepo is all-TS and the runner
>   core needs Node (`@everdict/agent`'s `runAgentJob`), which Electron's main process runs **in-process** —
>   no sidecar binary; bundled Chromium renders the Next 16 / Tailwind v4 app identically on every OS;
>   tray / auto-update / deep-link / keychain (`safeStorage`) are mature. The Tauri alternative is
>   smaller (~10MB vs ~100MB) but needs a Node sidecar for the runner, adds a Rust toolchain to a
>   TS-only repo, and renders through per-OS webviews (WebKitGTK/WebKit/WebView2 variance against a
>   complex Tailwind v4 app). For a resident dev tool, size is the cheaper sacrifice.
> - **D3 — the runner rides along, paired one-click from the logged-in session.** The desktop's native
>   payload is the [self-hosted runner](./self-hosted-runner.md): the runner loop (extracted to
>   `packages/self-hosted-runner`) runs in the Electron main process. Pairing needs **zero token copy-paste**:
>   the account page, when it detects the desktop bridge, offers "Connect this device as a runner" → the web (already
>   authenticated as the user) calls the existing pair API → hands the `rnr_` token to the bridge → main
>   process stores it in the OS keychain and starts the runner. Ownership stays personal (self-hosted-runner
>   D1) — the desktop just removes the friction.
> - **D4 — the bridge is minimal and origin-gated.** One preload API (`window.everdictDesktop`) with a
>   handful of IPC methods; `contextIsolation: true`, `nodeIntegration: false`; the preload is attached
>   **only** for the configured web origin. The renderer is the *remote web app* — it must never get
>   ambient Node/Electron power.
> - **D5 — auth stays exactly the web's; the desktop holds no access token.** Keycloak login happens in
>   the webview via Auth.js, the access token lives where it does in a browser — the **web origin's
>   server-side httpOnly cookie session** (the web is a BFF token courier, `docs/web.md`). The only
>   secret the desktop itself persists is the `rnr_` pairing token (keychain via `safeStorage`).
>   Outbound OAuth (connected accounts) also works unchanged: `authorizeUrl` → provider → 302 back to
>   `/<ws>/account` — all inside the webview, same as a browser tab.

Like [self-hosted-runner](./self-hosted-runner.md): **strict generalization, not a clean break.** The web,
the control plane, the MCP runner protocol (`lease_job`/`submit_job_result`/`heartbeat_job`), and the
`everdict runner` CLI are all untouched; the desktop is additive. The CLI remains the headless/CI answer.

## Problem

Two gaps, one product answer:

1. **Runner UX friction.** `everdict runner` lives in `apps/cli`, so a member must clone + `pnpm` build the
   monorepo, copy a shown-once `rnr_` token from the account page into `--pair <rnr_…> --api-url <url>`,
   and keep a terminal open forever (Ctrl-C kills it). The persona — "workspace member, not an everdict
   developer" — is exactly who this excludes.
2. **The requirement is web parity, not a companion.** A tray-only runner app would leave members
   juggling two surfaces (browser for evals, tray for the runner). The requirement: one desktop app that
   does **everything the web does** — dashboard, runs, harnesses, datasets, scorecards, judges, runtimes,
   settings, account — *and* hosts the runner.

The trap to avoid: re-implementing the UI in the desktop. `apps/web` is ~all of the product surface and
ships continuously; a second UI would fork every screen and rot immediately. D1 dissolves the parity
requirement structurally: parity is not a feature to build, it's a property of rendering the same app.

## Current state — verified

- **Web = BFF token courier** (`docs/web.md`) — Next.js 16 App Router; Auth.js keeps the Keycloak access
  token in a server-only httpOnly cookie; `control-plane.ts` forwards `Bearer` to `@everdict/api`; identity
  from `GET /me`. Pure HTTP client, **no `@everdict/*` deps**. Nothing about it assumes a browser tab — a
  webview holding the same cookies behaves identically.
- **Runner loop is already transport-clean** — `apps/cli/src/runner-loop.ts` (`runLeaseWorkers`, N lease
  workers over one MCP session) + `runner-session.ts` (`ResilientMcpSession` — reconnect-on-stale-session)
  + `run-leased-job.ts`, driving `runAgentJob` (`@everdict/agent`). It depends on flags + a token, not on
  being a CLI — extraction to a package is mechanical.
- **Pairing is a personal API** — `rnr_` token minted from the account page (BFF + MCP parity,
  self-hosted-runner slice 1), SHA-256-hashed at rest, owner = `principal.subject`, no role gate. A
  desktop bridge can drive the *same* endpoint from the logged-in web session.
- **Presence** — the web derives online/offline from `lastSeenAt` freshness; a desktop-resident runner
  long-polling `lease_job` keeps it green without the user thinking about it.

## Design

```
┌─ apps/desktop (Electron) ─────────────────────────────────────────────┐
│ main process                        renderer (BrowserWindow)          │
│  ├─ runner host: @everdict/self-hosted-runner  │  loads deployed apps/web URL   │
│  │   (lease → runAgentJob → submit)  │  (Keycloak login, all screens, │
│  ├─ keychain (safeStorage): rnr_     │   session cookies live here)   │
│  ├─ tray: status / start·stop / quit │                                │
│  ├─ autostart · auto-update · notify │  preload: window.everdictDesktop  │
│  └─ IPC ⇅ ─────────────────────────────  (origin-gated, minimal)     │
└───────────────────────────────────────────────────────────────────────┘
        │ MCP /mcp (rnr_ token: lease/submit/heartbeat)      │ HTTPS (web origin)
        ▼                                                    ▼
   control plane (@everdict/api) ◄──── Bearer (web BFF) ──── deployed apps/web
```

### `packages/self-hosted-runner` — one runner, three consumers

Move `runner-loop.ts` / `runner-session.ts` / `run-leased-job.ts` (+ their tests) from `apps/cli` into
`packages/self-hosted-runner` (depends on `@everdict/agent`, `@modelcontextprotocol/sdk`; sits at the same layer as
`apps/*` consumers of `agent`). Exports: `runLeaseWorkers(opts)`, `ResilientMcpSession`, `mcpConnect`,
plus a small `RunnerHost` facade (start/stop/status events) for GUI embedding. `apps/cli` re-imports and
behaves identically (pure refactor slice); `apps/desktop` main process embeds `RunnerHost`. (A future CI
runner would be the third consumer.)

### The bridge (`window.everdictDesktop`) — smallest possible surface

Preload-exposed, only when `new URL(window.location).origin === configuredWebOrigin`:

- `pairRunner({ token, runnerId?, apiUrl? }): Promise<void>` — web hands a freshly-minted `rnr_` token down;
  main stores it (keychain token map, keyed by `runnerId`) and starts that runner. **Additive** (D9): each call
  registers one more runner; a re-pair of the same `runnerId` replaces just its host. The token crosses the bridge
  once, is never persisted by the web, and never comes *back* up.
- `runnerStatus(): Promise<{ runners: DesktopRunnerStatus[] }>` + a `subscribe` event for live updates — the
  aggregate over **every** runner paired on this device (D9), so the roster shows each *this device* row truthfully
  instead of `lastSeenAt` guessing. (An older desktop returns a bare `DesktopRunnerStatus`; the web normalizes it.)
- `unpairRunner(runnerId?): Promise<void>` — stop + forget one runner's keychain entry, or (omitted) all of them
  (web still calls the revoke API — the authority stays server-side).
- `reconnectRunner(runnerId?): Promise<void>` (D12) — force one runner (or, omitted, all) to reopen its MCP session and
  resume leasing. The recovery lever for a runner shown "offline" (its lease loop can't reach the control plane, so it
  never refreshes `lastSeenAt`), without discarding the pairing. **Optional** on the web mirror
  (`typeof bridge.reconnectRunner === 'function'`) so an older shell degrades gracefully.
- `appInfo(): { version, platform, hostname, capabilities, cpuCount }` — for the account page to render "this device"
  affordances, and `cpuCount` for the soft-cap warning (D9).

That's the whole *runner* API. No generic `invoke`, no fs/shell access, nothing else. The one sibling surface is the
**window-chrome** namespace `window` (D10 — custom frameless title bar): `minimize()` / `toggleMaximize()` / `close()` /
`isMaximized()` / `onMaximizeChange(cb)`, benign window management under the same origin gate. Absent on an older
native-frame desktop, so the web gates its custom title bar on `window` being defined.

Two further bridges are **not** web-origin surfaces but local trusted pages, each behind its own argv flag and gated by an
exact `file://` senderFrame match (never the web, never an external page): `window.everdictSetup` (D8 — the setup window,
`--everdict-setup`) and `window.everdictTray` (D11 — the tray popover, `--everdict-tray`: `getState` / `onState` /
`action` / `resize` / `hide`). Never merge either into `everdictDesktop`.

### One-click pairing flow (D3)

1. Member opens the desktop app → logs into Keycloak in the webview (first run only; cookies persist).
2. Account page (`/<ws>/account`) sees `window.everdictDesktop` → the connected-runners section shows
   **"Connect this device as a runner"** (prefilled label = hostname from `appInfo`).
3. Click → web calls the **existing** pair endpoint (BFF, user session) → gets the shown-once `rnr_`
   token → `everdictDesktop.pairRunner({ token, apiUrl, label })` → main stores in keychain, starts
   `RunnerHost`, long-poll begins → presence dot goes green.
4. Web-side change is one small desktop-aware branch in the existing account/runner feature — no new
   endpoints, no new auth path.

### Runner lifecycle in the desktop

- **Start/stop** — auto-start the runner on app launch when paired (toggle in tray + account page);
  tray shows `idle / running (n) / off`.
- **Capabilities** — same detection as the CLI (docker present → `service` harnesses allowed;
  auto-advertise per self-hosted-service-runner); surfaced as a status row, not a log-line banner.
- **OS notifications** — job/scorecard completion notifies locally (the local analog of the Mattermost
  notify path); click → deep-link the window to the run/scorecard page.
- **Autostart** — OS login item (Electron `setLoginItemSettings`), so "a runner that's up at boot" holds.
- **Updates** — electron-updater for the shell; **UI updates need no desktop release** (D1 payoff — the
  web deploys, the desktop just renders it).

### Reuse vs new

| Piece | Status |
|---|---|
| Entire UI (`apps/web` deployed) — all screens, auth, role-gating | **reused verbatim** — the whole point (D1) |
| Runner protocol (MCP `lease_job`/`submit_job_result`/`heartbeat_job`) + pairing API | **reused, untouched** |
| Runner loop (`runLeaseWorkers`, `ResilientMcpSession`, `runAgentJob` path) | **extracted** → `packages/self-hosted-runner` (pure refactor) |
| `everdict runner` CLI | **kept** — thin wrapper over `self-hosted-runner`, headless/CI answer |
| `apps/desktop` (Electron shell: window, tray, keychain, autostart, updater, IPC) | **new** |
| `window.everdictDesktop` preload bridge + web desktop-aware pairing branch | **new** (bridge) + **small web edit** |
| Packaging/signing (linux AppImage/deb · mac dmg+notarize · win nsis) + download links on the account page | **new** |

## Slices (each lands green: format/lint/typecheck/test/build)

1. ✅ (`bbc7b58`) **`packages/self-hosted-runner` extraction** — move loop/session/leased-job + tests out of `apps/cli`;
   CLI re-imports; zero behavior change (CLI live e2e re-run proves it).
2. ✅ (`e2b903a`) **Shell** — `apps/desktop` Electron app: BrowserWindow on the deployed web URL, persistent session
   (Keycloak login sticks), navigation policy (top-level http/https allowed — OIDC/OAuth redirect flows
   must leave and re-enter the web origin; `window.open` to non-web origins → system browser), tray
   skeleton, autostart toggle. No runner yet — this alone already *is* "identical to the web".
   (electron-updater moves to slice 5 — it belongs with electron-builder packaging.)
3. ✅ **Bridge + one-click pairing** — preload `window.everdictDesktop` (origin-gated: preload arg-origin gate +
   main-side `senderFrame` check), `safeStorage` keychain token store, `RunnerHost` (self-hosted-runner facade:
   start/stop/status events over `runLeaseWorkers`) embedded via `RunnerController` (pair/unpair/restore-on-boot);
   web: desktop-aware "Connect this device as a runner" one-click (label=hostname, token never shown — bridge-only) +
   live "this device" status row (running(n)/online) replacing the `lastSeenAt` heuristic for this device.
4. ✅ **Runner surface polish** — tray status row + tooltip (not paired / online idle / running (n)) and
   tray-local unpair (token discard + stop; server-side revoke stays the web's authority); OS
   notification per **drain** (running→idle transition, success/failure aggregate — per-case notify would
   spam batches; click → focus window); web "this device" row prefers **live** capabilities from the
   bridge (+ "no docker → service harnesses unavailable" hint), so a docker daemon stopped after pairing
   shows immediately.
5. ✅ **Packaging + live e2e** — linux: esbuild single-file bundle (main ESM + preload CJS,
   `electron` external — avoids packing pnpm-symlinked `node_modules` into asar; `extraMetadata.main`
   swaps the entry only in the package) + electron-builder AppImage (`pnpm -F @everdict/desktop package`,
   NOT in turbo gates), packaged binary smoke-verified. **Download link**: `DESKTOP_DOWNLOAD_URL`
   (web env, optional) → Account > Connected runners shows an "Install the desktop app" link to browser users only
   (hidden inside the desktop). **Live e2e PASS** (`scripts/live/desktop-runner.mjs`, 2026-07-03):
   Playwright drives the real Electron shell (clean `XDG_CONFIG_HOME` = fresh machine) → account page
   one-click "Connect this device as a runner" → runner online with live "this device" row → run pinned to
   `self:<id>` executes on the desktop → `provenance{ranOn:self-hosted, runner, by}` verified.
   Keyring-less Linux needed one product fix: opt in to safeStorage `basic_text` with a logged warning
   (VSCode-style), else `isEncryptionAvailable()=false` blocks pairing.
6. ✅ **Release CI** (`.github/workflows/desktop-release.yml`) — tag `desktop-vX.Y.Z` (or manual
   dispatch → draft) fans out a 3-OS matrix (ubuntu/macos/windows runners): version injected from the
   tag, `turbo build --filter=@everdict/desktop` (dep chain only), esbuild bundle → electron-builder
   per-OS (`--linux` AppImage+deb · `--mac` dmg+zip×[x64,arm64] · `--win` nsis), then one job collects
   artifacts into a single **GitHub Release** (`softprops/action-gh-release`, auto release notes).
   Deterministic artifact names (`Everdict-<ver>-<os>-<arch>.<ext>`). All targets **unsigned** until certs
   exist (`CSC_IDENTITY_AUTO_DISCOVERY=false`); `latest*.yml` uploaded for a future electron-updater.
   Point the web's `DESKTOP_DOWNLOAD_URL` at `https://github.com/everdict/everdict/releases/latest`.
   **Remaining**: signing certs (mac notarize / win Authenticode) — config hooks noted in
   `electron-builder.yml`.
7. ✅ **Download page** (D7 follow-up — the `everdict/everdict` repo is public, same feed as the auto-updater) —
   `/{workspace}/download`: the web **server** reads the latest `desktop-v*` release from GitHub. The public repo
   reads **unauthenticated** (`DESKTOP_RELEASES_REPO`, 5-min cached, `features/download-desktop`);
   `DESKTOP_RELEASES_TOKEN` is **optional** — only a private releases repo needs it (it also lifts the rate limit).
   Renders OS-detected recommended buttons (UA → linux/mac/win; mac shows arm64+x64 — arch is not UA-reliable)
   + an all-platforms list + post-install steps + unsigned caveats. Actual downloads go through
   `GET /api/desktop/download?id=…`: session-checked (`currentPrincipal`), asset id validated against **our**
   desktop release only, then GitHub's octet-stream 302 → **signed temporary URL** is passed to the browser
   (big files never stream through the web server). The Runners tab CTA links here (internal) instead of an
   external URL; `DESKTOP_DOWNLOAD_URL` remains as the page's fallback when release metadata can't be fetched
   (a private repo with no token). Live-verified: page renders v0.1.0 assets; valid id → 302 to
   `release-assets.githubusercontent.com`; foreign id → 404.
8. ✅ **Auto-update client** (D6) — `UpdaterController` (`updater.ts`, DI + vitest) + tray UX
   (`Downloading update… (n%)` disabled row → `Apply vX update (restart)` action) + ready OS
   notification; apply = graceful runner shutdown → `quitAndInstall(false, true)` with the
   before-quit preventDefault path flagged off. **Live-verified** (2026-07-03, packaged AppImage vs
   local generic feed): idle → checking → found 0.2.0 → downloading (126MB fresh) → sha512 verify →
   ready. Finding: `setFeedURL` alone breaks at download (AppImageUpdater reads on-disk config) —
   env activation writes `userData/app-update.yml` and injects it via `updateConfigPath`.
   **Open**: flip the feed on — user decision (a) public `everdict-releases` + CI PAT vs (b) repo
   public; then add the `publish` block to `electron-builder.yml` (nothing else changes).
9. ✅ **Multiple runners per device** (D9) — the single-runner client became a **supervisor** of many. Persistence:
   `token-store` gained an encrypted map (`runner-tokens.bin`, `{ runnerId: rnr_token }`) + `config.runners[]`, with a
   one-time startup migration of the legacy `runner-token.bin` + scalar meta. `RunnerSupervisor` (replaces
   `RunnerController`) owns a `Map<runnerId, RunnerHost>`: `pair` is additive (a re-pair of the same id replaces just
   that host), `unpair(runnerId?)` drops one or all, `status()` aggregates `{ runners: [] }`, `shutdown()` stops every
   host. The bridge grew to match (invariant 3): `runnerStatus()` → list, `unpairRunner(runnerId?)`, `appInfo().cpuCount`.
   Web: the runners page connects **additively** ("Connect another runner"), each runner is its own live row + revoke,
   a **soft-cap** warning shows once this device hosts ≥ `cpuCount` runners (never blocks), and a "clean up" callout
   discards local tokens for pairings no longer in the roster. Version-skew: a new web **normalizes** an old desktop's
   bare status object. `RunnerHost` / the MCP lease protocol / the server `self` pool are untouched — additive by
   construction. Gates green (desktop 63 tests + web lint/typecheck). **Open**: live multi-runner e2e (extend
   `scripts/live/desktop-runner.mjs` to pair two runners and confirm both lease).

## Decisions / non-goals

- **No UI re-implementation in the shell — ever.** If a screen needs desktop awareness, it's a
  `window.everdictDesktop`-conditional branch in `apps/web`, not a desktop-side screen.
- **No offline/local control plane.** The desktop is online like the web; the control plane stays remote.
  (A run *executes* locally via the runner — that part already works offline-ish by nature of pull.)
- **CLI stays first-class.** Headless boxes, CI, and servers keep `everdict runner`; the desktop is the
  human-machine answer, not a replacement.
- **Renderer gets no Node.** `contextIsolation` on, `nodeIntegration` off, bridge origin-gated —
  the remote web app must never gain local power beyond the four bridge methods.
- **Electron vs Tauri** — D2 locked Electron (all-TS, in-process runner, rendering consistency);
  revisit Tauri only if footprint becomes a real complaint, since D1/D3/D4/D5 are shell-agnostic.

## See also

[self-hosted-runner](./self-hosted-runner.md) · [self-hosted-service-runner](./self-hosted-service-runner.md) ·
`docs/web.md` · `docs/auth.md` · `docs/connections.md` · `docs/mcp.md` · skills `foundation`, `api-layer`.
