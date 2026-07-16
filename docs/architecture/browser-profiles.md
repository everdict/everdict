# Authenticated browser profiles — a real interactive remote browser, cookies reused in eval (design)

> **Status: S0–S6 SHIPPED (S1 transport + web canvas · S2 profile entity · S3 cookie capture · S4 proxy/geo login browser · S5 cookie injection into evals · S6 containerized provisioner — no host-Chrome dependency). Follow-ups: managed-K8s reachability, eval-browser proxy, localStorage, web harness profile-picker.** S0 = the interactive live browser
> session primitive (`openBrowserSession`, `@everdict/topology`, `a168b5b`): CDP screencast (frames OUT, each
> acked) + input (mouse/keyboard/navigate IN), transport-injectable, live-proven against real Chrome via
> `scripts/live/interactive-browser.mjs`. **S1 productizes the transport end-to-end**: a personal / self-scoped
> `BrowserSession` resource (`apps/api` `core/browser-session` + `api/browser-session`, in-memory, single active
> session per owner, TTL) provisioned by a `BrowserSessionProvisioner` port (S1 impl = `LocalChromeProvisioner`,
> a host Chrome on the reachable local path; env-gated `EVERDICT_BROWSER_SESSIONS`), a WS relay
> `/browser-sessions/:id?ticket=…` (generic `TicketStore` + the terminal-WS upgrade pattern; frames OUT + validated
> input IN via `browser-session-ws.ts`), BFF↔MCP parity, and the `apps/web` canvas
> (`features/interactive-browser`, Settings › Account › Browser sessions). The reachable CDP base is **server-only**
> (never crosses the wire — the client gets a one-shot ticket). What remains: the profile entity, cookie capture,
> geo proxy, injection into eval runs, and managed-runtime (Docker/K8s) provisioners.

## The feature (browser-use cloud parity)

Register a **browser profile** in settings; pick a **country** (egress proxy); a real browser opens that the user
drives **remotely in real time** — navigate, click, **log into a site**; the resulting **cookies / storage state**
are remembered; and subsequent **browser eval tasks reuse that profile** (proxy + cookies) so the agent runs as the
logged-in user. This directly unblocks authenticated/commercial sites in browser evals (today WebVoyager's
commercial slice falls back to 0% because there is no login — see `browser-use-bundle-eval`).

## Why it fits Everdict (current state — verified file:line)

- **Per-case browser already provisioned.** `TopologyRuntime.provisionBrowserEnv(spec, runId, zone)`
  (`packages/topology/src/deploy/topology-runtime.ts:24`) brings up `chromedp/headless-shell` with CDP on 9222 and
  returns a `cdpUrl` + `snapshot()` (docker/nomad/k8s impls). The browser + CDP endpoint already exist per case.
- **CDP is already how we talk to the browser.** `capture-cdp.ts` opens a page target's CDP WebSocket and issues
  commands (`Page.captureScreenshot`) — a proven, transport-injectable pattern.
- **The interactive primitive is now proven (S0).** `openBrowserSession(cdpHttpBase)`
  (`packages/topology/src/front-door/browser-session.ts`) is the bidirectional sibling: `Page.startScreencast` →
  `Page.screencastFrame` (acked — an unacked frame stalls the stream) for frames OUT; `Input.dispatchMouseEvent` /
  `dispatchKeyEvent` / `Page.navigate` for input IN. Commands issued before the socket opens are queued then flushed.
- **A WS-relay-to-the-web precedent already exists.** The sandbox web terminal: `Shellable.execStream` →
  `ExecStreamHandle` (`packages/backends/src/backend.ts:111`) relayed over a `noServer` `WebSocketServer`
  (`apps/api/src/server.ts:3583`), authed by a short-lived single-use **ticket** (`TerminalTicketStore`,
  `apps/api/src/lib/terminal-ticket.ts`) because a browser can't set an `Authorization` header on a WebSocket. The
  browser session route is the same shape with CDP frames/input instead of PTY bytes.
- **Object storage + encryption for the cookie blob.** `packages/storage` (artifact-store + s3) for the
  `storageState` blob; `db` `secret-cipher` for encryption at rest (cookies = login credentials).
- **A settings-UI + personal-ownership pattern.** `apps/web` `manage-*` features; connected-accounts are
  personally-owned + self-scoped (`packages/auth/src/authz.ts`) — the right ownership default for login material.

So the primitive and every supporting seam exist; the feature is largely additive.

## The transport chain (S1 — the subject of this slice)

```
apps/web  (canvas: draw screencast frames · forward mouse/keyboard/nav)
   ↕  WebSocket  (authed by a one-shot ticket — browsers can't set Authorization on a WS)
apps/api  (WS route: relay frames ↔ input; the terminal-WS pattern, CDP instead of PTY)
   ↕  openBrowserSession(cdpHttpBase)   (CDP — proven in S0)
browser in a runtime  (dedicated interactive browser for login, OR an attached per-case eval browser)
```

- **Ticket auth** — `POST …/browser-sessions/:id/ticket` (owner-only) mints a single-use, ~30s ticket bound to
  `(sessionId, subject)`; the web opens `WS …/browser-sessions/:id?ticket=…`; the upgrade handler consumes it.
  Reuse/generalize `TerminalTicketStore` (it is `(runId, subject)` today → make the key generic).
- **Relay** — on upgrade: `openBrowserSession(cdpHttpBase)`; pipe `session.onFrame → ws.send(frame)` and
  `ws.onmessage(input) → session.mouse/key/navigate`. (`scripts/live/interactive-browser.mjs --serve` is the
  reference relay, over SSE+POST; the productized version is one WS.)

### The genuinely hard part: control-plane → browser CDP reachability

The browser's CDP is on a private port inside a runtime; apps/api must reach it to relay. Options by runtime:

| Runtime | Reachability | Difficulty |
|---|---|---|
| **local Docker / self-hosted** | published host port (or localhost) — `capture-cdp` already reaches it | trivial (S1 target) |
| **Nomad** | alloc published port (as `captureScreen`/snapshot already discover) | small |
| **K8s** | per-session `kubectl port-forward` or an ingress to the pod's CDP | **the real ops cost** — same shape as `K8sTopologyRuntime`'s port-forward-for-endpoints; do it as its own slice |

`captureScreen(runId)` already reaches the browser CDP once (for a screenshot), so the path exists; a **persistent
bidirectional session** is the increment. **S1 targets the local-Docker path** (reachable, provable here); managed
K8s reachability is a separate slice, not a blocker for proving the productized transport.

## Dedicated interactive browser for profile login (S1 cont.)

Profile login is not an eval — there is no case. So we provision a **dedicated interactive browser** just for the
login session: reuse `provisionBrowserEnv`'s container recipe, but keyed by `browserSessionId` (not a run), with the
profile's **proxy** as a launch arg (`--proxy-server=<geo>`). Teardown on session close (or TTL). Managed = one
short-lived container/pod per active login; self-hosted = the user's own local browser (no geo).

## The profile entity + capture + injection (S2–S5)

- **`BrowserProfileSpec`** (`core`): `{ id, name, country?, proxyRef?, cookieDomains[], createdBy, storageStateRef,
  updatedAt }`. Owner = subject (self-scoped, like connected accounts); optional workspace share later.
- **`BrowserProfileStore`** (`db`): the metadata; the `storageState` blob lives in `storage` (S3), **encrypted**
  (`secret-cipher`), keyed `(workspace|subject, profileId)`.
- **Capture** (S3): ✅ SHIPPED. `captureStorageState(cdpBase)` (`@everdict/topology`) reads the session's cookies
  via CDP `Network.getAllCookies` → a Playwright-style `storageState`; the apps/api `BrowserProfileCaptureService`
  (`core/browser-profile`) encrypts it (AES-256-GCM, the shared `SecretCipher`) → `store.saveState` persists the
  opaque blob (`state_cipher`, migration `0059`) + `capturedAt` + the refined `cookieDomains`. Owner-gated on both
  the profile and the session; the blob is **server-only** (`loadState` reads it back for S5). Route
  `POST /browser-profiles/:id/capture {sessionId}` + MCP `capture_browser_profile`. Web: "Save login" on the
  interactive-session panel (create profile → capture) + a `capturedAt` badge on the profiles list. (localStorage
  capture via `Runtime.evaluate` is deferred — cookies are the login material for most sites.)
- **Proxy / geo** (S4): ✅ SHIPPED (login browser). `WorkspaceSettings.proxies` (BYO per-country pool, like
  image-registries/trace sinks; `{name, country, url, authSecretName?}`, the auth secret a SecretStore name-ref) +
  `ProxyService` (`@everdict/application-control`: list/upsert/remove admin (settings:write) + `resolve(country)` →
  the `--proxy-server` value, folding the auth secret into the URL). Routes `GET /workspace/proxies` (workspace read,
  no role gate — the session geo picker consumes it) + `PUT`/`DELETE` (admin) + MCP parity. The interactive session
  (`BrowserSessionService.create({country})`) resolves the country → the `LocalChromeProvisioner` launches Chrome
  with `--proxy-server`; web adds a Settings › Proxies admin card + a geo picker on the session panel. **Eval-browser
  proxy is S5.** Known limit: headless Chrome doesn't honor inline proxy *auth* — full authed-proxy support needs CDP
  `Fetch.continueWithAuth` (a follow-up); open proxies + inline-cred setups work today.
- **Injection** (S5): ✅ SHIPPED (cookies). A service harness's `target.profile` (an id) → `seedStorageState(cdpBase,
  state)` (`@everdict/topology`, the inverse of capture: CDP `Network.setCookies`) seeds the profile's decrypted
  cookies into the per-case browser **before the agent connects** (`ServiceTopologyBackend.seedProfile` hook, called
  after target-acquire + before the front-door drive, using the control-plane-reachable `runtime.browserCdpBase`).
  The `makeProfileSeeder` injector (`apps/api core/browser-profile`, wired in `buildDispatch`) resolves the profile by
  `(tenant, id)`, **owner-gates it against `job.submittedBy`** (a mismatch/absence skips injection — no cookie theft),
  decrypts the blob (the shared `SecretCipher`), and seeds. **Best-effort** — a seed failure never fails the run (the
  eval just runs unauthenticated). Follow-ups: eval-browser **proxy** at launch (the login browser has it via S4;
  `provisionBrowserEnv --proxy-server` across the 3 runtimes is the increment), localStorage seeding, self-hosted-runner
  path wiring, and a web profile-picker in the harness target form (`target.profile` is API/MCP/raw-JSON-settable today).

## Slices

1. **S0 — interactive session primitive.** ✅ SHIPPED (`a168b5b`), live-proven.
2. **S1a — WS transport through apps/api.** ✅ SHIPPED. Generic `TicketStore` (`common/ticket-store.ts`) + the
   `BrowserSession` resource slice (`core/browser-session` service — in-memory, owner-scoped, one active session
   per owner, TTL sweep; `api/browser-session` routes + docs + MCP parity) + the `WS /browser-sessions/:id?ticket=…`
   relay (`browser-session-ws.ts` — CDP frames OUT as JSON + Zod-validated mouse/keyboard/navigate IN, early-input
   buffered like the terminal WS) + a `BrowserSessionProvisioner` port with a host-Chrome `LocalChromeProvisioner`
   (the reachable local/self-hosted path; managed Docker/K8s provisioners = a later slice, folds into S6). The
   reachable CDP base is **server-only**. Env-gated `EVERDICT_BROWSER_SESSIONS` (the S1 provisioner launches a host
   Chrome). Note: the terminal path keeps its own `TerminalTicketStore` (unchanged) — unifying it onto `TicketStore`
   is a deferred cleanup.
3. **S1b — apps/web canvas feature.** ✅ SHIPPED. `features/interactive-browser` (the `--serve` page productized:
   one WS instead of SSE/POST) + BFF proxy routes (`/api/browser-sessions*`, ticket route injects the WS base) +
   Settings › Account › Browser sessions page + ko/en i18n. Users start a browser and drive it inside the app.
4. **S2 — profile entity.** ✅ SHIPPED. `BrowserProfileRecord` (`@everdict/contracts`) — personal / self-scoped
   `{ id, tenant, name, cookieDomains[], createdBy, createdAt, updatedAt }` (the `storageStateRef`/`country`/`proxyRef`
   fields are deferred to the slices that populate them — S3/S4 — per no-hypothetical-surface); `BrowserProfileStore`
   port (`@everdict/application-control`) + `InMemory`/`Pg` impls (`@everdict/db`, migration `0058`,
   `everdict_browser_profiles`) + `BrowserProfileService` (owner-scoped CRUD, no admin override — a profile holds
   personal login material) + `api/browser-profile` routes/docs/MCP parity (self-scoped, no role gate) + the
   `apps/web` `features/manage-browser-profiles` manager (Settings › Account › Browser profiles: create/rename/delete)
   + `entities/browser-profile` drift-guarded schema + ko/en i18n. A profile is a login placeholder until S3 captures
   cookies into it.
5. **S3 — cookie capture** on session save (`Network.getAllCookies` → storageState → encrypt → store). ✅ SHIPPED.
6. **S4 — proxy / geo** (`ProxyProvider`, `--proxy-server`). ✅ SHIPPED for the login browser (eval-browser proxy = S5).
7. **S5 — injection into eval** (seed cookies before the agent connects). ✅ SHIPPED (cookies; proxy-at-eval-launch is a follow-up).
8. **S6 — containerized provisioner (decouple from host Chrome).** ✅ SHIPPED. `DockerBrowserProvisioner`
   (`apps/api infrastructure`, reuses the topology `Docker` adapter / `dockerCli`) runs a `chromedp/headless-shell`
   CONTAINER with CDP published to a host port — the control-plane host needs Docker + a pulled image but **no host
   Chrome install** (removes the local-environment dependency of `LocalChromeProvisioner`). Selected by
   `EVERDICT_BROWSER_PROVISIONER=docker` (+ `EVERDICT_BROWSER_IMAGE`/`_DOCKER_NETWORK`); the host-Chrome provisioner
   stays the default for dev/self-hosted. The CDP-in-container reported-WS-host ≠ published-host-port mismatch is
   fixed by `reachableWsUrl` (rewrites the reported `webSocketDebuggerUrl` authority to the reachable CDP base — a
   no-op for host Chrome), applied in `openBrowserSession`/`captureCdpScreenshot`/`captureStorageState`/`seedStorageState`.
   Follow-up: managed **K8s** reachability (per-session `kubectl port-forward` / ingress to the pod CDP) — lifts this
   from a control-plane-host Docker daemon to the SaaS cluster.

## Non-goals / risks

- **Security is the through-line.** A live CDP-driven browser is powerful (navigate anywhere, exec JS) — that is the
  point (the user drives it), so gate it HARD: owner-only ticket, single active session, TTL, isolated egress (trust
  zone). Cookies = login credentials → encrypted at rest, never logged, transient in the browser, personal scope.
- **Cookie expiry** — profiles go stale; surface staleness + a one-click re-login (re-run S1 + S3).
- **Quality** — CDP screencast is modest-fps JPEG; fine for login/navigation, not smooth video.
- **Not a general remote-desktop** — one page target, browser only; no multi-tab orchestration in v1.
