# Desktop app — full web parity + resident self-hosted runner

> **Status: decisions D1–D5 LOCKED with the user (2026-07-03) — implementation in progress.**
> Supersedes the "tray-only companion" idea: the user requirement is **데스크탑앱으로도 웹처럼 동일하게
> 수행** — the desktop must do *everything the web does*, plus what only a native app can do (resident
> runner, one-click pairing, tray/notifications/autostart).
> Dev conventions for `apps/desktop` / `packages/runner-core` live in skill `.claude/skills/desktop/`.
>
> - **D1 — the UI is the deployed web, not a rebuild.** The desktop shell renders the SaaS web
>   (`apps/web`) at its deployed URL inside the app window — the Linear/Slack/Notion model. `apps/web`
>   stays the **single UI SSOT**; the desktop has feature parity *by construction* (every web deploy
>   lands in the desktop instantly, no app release). We never fork or re-implement screens in the shell.
> - **D2 — shell is Electron (LOCKED).** Rationale: the monorepo is all-TS and the runner
>   core needs Node (`@assay/agent`'s `runAgentJob`), which Electron's main process runs **in-process** —
>   no sidecar binary; bundled Chromium renders the Next 16 / Tailwind v4 app identically on every OS;
>   tray / auto-update / deep-link / keychain (`safeStorage`) are mature. The Tauri alternative is
>   smaller (~10MB vs ~100MB) but needs a Node sidecar for the runner, adds a Rust toolchain to a
>   TS-only repo, and renders through per-OS webviews (WebKitGTK/WebKit/WebView2 variance against a
>   complex Tailwind v4 app). For a resident dev tool, size is the cheaper sacrifice.
> - **D3 — the runner rides along, paired one-click from the logged-in session.** The desktop's native
>   payload is the [self-hosted runner](./self-hosted-runner.md): the runner loop (extracted to
>   `packages/runner-core`) runs in the Electron main process. Pairing needs **zero token copy-paste**:
>   the account page, when it detects the desktop bridge, offers "이 기기를 러너로 연결" → the web (already
>   authenticated as the user) calls the existing pair API → hands the `rnr_` token to the bridge → main
>   process stores it in the OS keychain and starts the runner. Ownership stays personal (self-hosted-runner
>   D1) — the desktop just removes the friction.
> - **D4 — the bridge is minimal and origin-gated.** One preload API (`window.assayDesktop`) with a
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
`assay runner` CLI are all untouched; the desktop is additive. The CLI remains the headless/CI answer.

## Problem

Two gaps, one product answer:

1. **Runner UX friction.** `assay runner` lives in `apps/cli`, so a member must clone + `pnpm` build the
   monorepo, copy a shown-once `rnr_` token from the account page into `--pair <rnr_…> --api-url <url>`,
   and keep a terminal open forever (Ctrl-C kills it). The persona — "workspace member, not an assay
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
  token in a server-only httpOnly cookie; `control-plane.ts` forwards `Bearer` to `@assay/api`; identity
  from `GET /me`. Pure HTTP client, **no `@assay/*` deps**. Nothing about it assumes a browser tab — a
  webview holding the same cookies behaves identically.
- **Runner loop is already transport-clean** — `apps/cli/src/runner-loop.ts` (`runLeaseWorkers`, N lease
  workers over one MCP session) + `runner-session.ts` (`ResilientMcpSession` — reconnect-on-stale-session)
  + `run-leased-job.ts`, driving `runAgentJob` (`@assay/agent`). It depends on flags + a token, not on
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
│  ├─ runner host: @assay/runner-core  │  loads deployed apps/web URL   │
│  │   (lease → runAgentJob → submit)  │  (Keycloak login, all screens, │
│  ├─ keychain (safeStorage): rnr_     │   session cookies live here)   │
│  ├─ tray: status / start·stop / quit │                                │
│  ├─ autostart · auto-update · notify │  preload: window.assayDesktop  │
│  └─ IPC ⇅ ─────────────────────────────  (origin-gated, minimal)     │
└───────────────────────────────────────────────────────────────────────┘
        │ MCP /mcp (rnr_ token: lease/submit/heartbeat)      │ HTTPS (web origin)
        ▼                                                    ▼
   control plane (@assay/api) ◄──── Bearer (web BFF) ──── deployed apps/web
```

### `packages/runner-core` — one runner, three consumers

Move `runner-loop.ts` / `runner-session.ts` / `run-leased-job.ts` (+ their tests) from `apps/cli` into
`packages/runner-core` (depends on `@assay/agent`, `@modelcontextprotocol/sdk`; sits at the same layer as
`apps/*` consumers of `agent`). Exports: `runLeaseWorkers(opts)`, `ResilientMcpSession`, `mcpConnect`,
plus a small `RunnerHost` facade (start/stop/status events) for GUI embedding. `apps/cli` re-imports and
behaves identically (pure refactor slice); `apps/desktop` main process embeds `RunnerHost`. (A future CI
runner would be the third consumer.)

### The bridge (`window.assayDesktop`) — smallest possible surface

Preload-exposed, only when `new URL(window.location).origin === configuredWebOrigin`:

- `pairRunner({ token, apiUrl, label }): Promise<void>` — web hands the freshly-minted `rnr_` token down;
  main stores it (keychain) and starts the runner. The token crosses the bridge once, is never persisted
  by the web, and never comes *back* up.
- `runnerStatus(): Promise<{ state: "off"|"idle"|"running"; runnerId?, label?, capabilities?, activeJobs? }>`
  + a `subscribe` event for live updates — lets the account page's 연결된 러너 roster show *this device*
  truthfully instead of `lastSeenAt` guessing.
- `unpairRunner(): Promise<void>` — stop + forget keychain entry (web still calls the revoke API — the
  authority stays server-side).
- `appInfo(): { version, platform }` — for the account page to render "이 기기" affordances at all.

That's the whole API. No generic `invoke`, no fs/shell access, nothing else.

### One-click pairing flow (D3)

1. Member opens the desktop app → logs into Keycloak in the webview (first run only; cookies persist).
2. Account page (`/<ws>/account`) sees `window.assayDesktop` → the 연결된 러너 section shows
   **"이 기기를 러너로 연결"** (prefilled label = hostname from `appInfo`).
3. Click → web calls the **existing** pair endpoint (BFF, user session) → gets the shown-once `rnr_`
   token → `assayDesktop.pairRunner({ token, apiUrl, label })` → main stores in keychain, starts
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
- **Autostart** — OS login item (Electron `setLoginItemSettings`), so "부팅하면 떠 있는 러너" holds.
- **Updates** — electron-updater for the shell; **UI updates need no desktop release** (D1 payoff — the
  web deploys, the desktop just renders it).

### Reuse vs new

| Piece | Status |
|---|---|
| Entire UI (`apps/web` deployed) — all screens, auth, role-gating | **reused verbatim** — the whole point (D1) |
| Runner protocol (MCP `lease_job`/`submit_job_result`/`heartbeat_job`) + pairing API | **reused, untouched** |
| Runner loop (`runLeaseWorkers`, `ResilientMcpSession`, `runAgentJob` path) | **extracted** → `packages/runner-core` (pure refactor) |
| `assay runner` CLI | **kept** — thin wrapper over `runner-core`, headless/CI answer |
| `apps/desktop` (Electron shell: window, tray, keychain, autostart, updater, IPC) | **new** |
| `window.assayDesktop` preload bridge + web desktop-aware pairing branch | **new** (bridge) + **small web edit** |
| Packaging/signing (linux AppImage/deb · mac dmg+notarize · win nsis) + download links on the account page | **new** |

## Slices (each lands green: format/lint/typecheck/test/build)

1. ✅ (`bbc7b58`) **`packages/runner-core` extraction** — move loop/session/leased-job + tests out of `apps/cli`;
   CLI re-imports; zero behavior change (CLI live e2e re-run proves it).
2. ✅ (`e2b903a`) **Shell** — `apps/desktop` Electron app: BrowserWindow on the deployed web URL, persistent session
   (Keycloak login sticks), navigation policy (top-level http/https allowed — OIDC/OAuth redirect flows
   must leave and re-enter the web origin; `window.open` to non-web origins → system browser), tray
   skeleton, autostart toggle. No runner yet — this alone already *is* "웹처럼 동일하게".
   (electron-updater moves to slice 5 — it belongs with electron-builder packaging.)
3. ✅ **Bridge + one-click pairing** — preload `window.assayDesktop` (origin-gated: preload arg-origin gate +
   main-side `senderFrame` check), `safeStorage` keychain token store, `RunnerHost` (runner-core facade:
   start/stop/status events over `runLeaseWorkers`) embedded via `RunnerController` (pair/unpair/restore-on-boot);
   web: desktop-aware "이 기기를 러너로 연결" one-click (label=hostname, token never shown — bridge-only) +
   live "이 기기" status row (running(n)/온라인) replacing the `lastSeenAt` heuristic for this device.
4. ✅ **Runner surface polish** — tray status row + tooltip (미페어/온라인 대기/실행 중 (n)) and
   tray-local unpair (token discard + stop; server-side revoke stays the web's authority); OS
   notification per **drain** (running→idle transition, 성공/실패 aggregate — per-case notify would
   spam batches; click → focus window); web "이 기기" row prefers **live** capabilities from the
   bridge (+ "docker 없음 → service 하니스 불가" hint), so a docker daemon stopped after pairing
   shows immediately.
5. ◐ **Packaging + live e2e** — linux DONE: esbuild single-file bundle (main ESM + preload CJS,
   `electron` external — avoids packing pnpm-symlinked `node_modules` into asar; `extraMetadata.main`
   swaps the entry only in the package) + electron-builder AppImage (`pnpm -F @assay/desktop package`,
   NOT in turbo gates), packaged binary smoke-verified. **Open**: signing, mac/win builds,
   account-page download links, and the fresh-machine live e2e (install → login → one-click pair →
   scorecard on `self:<id>` → result + provenance).

## Decisions / non-goals

- **No UI re-implementation in the shell — ever.** If a screen needs desktop awareness, it's a
  `window.assayDesktop`-conditional branch in `apps/web`, not a desktop-side screen.
- **No offline/local control plane.** The desktop is online like the web; the control plane stays remote.
  (A run *executes* locally via the runner — that part already works offline-ish by nature of pull.)
- **CLI stays first-class.** Headless boxes, CI, and servers keep `assay runner`; the desktop is the
  human-machine answer, not a replacement.
- **Renderer gets no Node.** `contextIsolation` on, `nodeIntegration` off, bridge origin-gated —
  the remote web app must never gain local power beyond the four bridge methods.
- **Electron vs Tauri** — D2 locked Electron (all-TS, in-process runner, rendering consistency);
  revisit Tauri only if footprint becomes a real complaint, since D1/D3/D4/D5 are shell-agnostic.

## See also

[self-hosted-runner](./self-hosted-runner.md) · [self-hosted-service-runner](./self-hosted-service-runner.md) ·
`docs/web.md` · `docs/auth.md` · `docs/connections.md` · `docs/mcp.md` · skills `foundation`, `api-layer`.
