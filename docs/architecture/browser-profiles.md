# Authenticated browser profiles — a real interactive remote browser, cookies reused in eval (design)

> **Status: S0–S9 SHIPPED (S1 transport + web canvas · S2 profile entity · S3 cookie capture · S4 proxy/geo login browser · S5 cookie injection into evals · S6 containerized provisioner — no host-Chrome dependency · S6b remote sidecar pool — socket-free multi-user self-hosted (`EVERDICT_BROWSER_PROVISIONER=remote`, lease-a-browser-from-a-pool, re-lease wipe) · S7 session-first creation UX + live remembered-login chips · S8 concurrent-session caps — per-tenant + fleet-wide · S9 runtime-bound sessions — the browser on the tenant's registered runtime inside its trust zone [Nomad shipped; K8s + self-hosted = follow-ups]). Follow-ups: K8s per-session reachability (port-forward), self-hosted reverse relay, store-backed session registry (multi-replica), web session runtime-picker, eval-browser proxy, localStorage.** S0 = the interactive live browser
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

### The creation UX is session-first (S7)

Making a profile IS a login session — not a metadata form. In Settings › Browser › Browser profiles, "New profile"
opens the wizard: name + geo (egress proxy country; admins manage the workspace proxy pool inline right there) →
**a live browser opens in the page** (the S1 canvas) → the user navigates to a site, logs in, moves on to the next
site, logs in again — one session accumulates any number of logins. While the session is open the wizard polls
`GET /browser-sessions/:id/state-preview` (owner-gated) and renders **selectable per-cookie rows** grouped by
domain. The preview returns each cookie's *name + expiry + httpOnly/secure flags* (cookie **values** NEVER cross
the wire) plus the server clock (`now`). One login sets a dozen unrelated cookies (analytics, consent, A/B buckets)
plus the real session token, so the wizard **auto-selects the authentication cookies** with a site-agnostic
heuristic (`features/manage-browser-profiles/lib/cookie-selection.ts`): `httpOnly` is the strongest signal (session
tokens are hidden from JS; analytics/prefs are JS-readable), backed by name patterns (`session`/`token`/`login`/
`csrf`/`__Host-`…) and analytics/preference deny-lists. Each row shows its **expiry date** (or "Session" for
session cookies, "Expired" in red for lapsed ones, judged against server `now`); **expired cookies are excluded and
non-selectable** (re-seeding a past-expiry cookie is a no-op). Selection is an explicit override layered over the
heuristic default (later polls never wipe a user's choice; a new cookie appears with its default); the domain header
toggles its selectable cookies; saving with zero selected is blocked. "Save profile & close" creates the profile (with the chosen `country`) + captures (S3) **only
the selected cookies** (`cookies: [{domain, name}]` on the capture body, domains preview-normalized [no leading
dot]; omitted = capture everything — the API/MCP default, 400 when a given selection matches nothing) + tears
the session down; "Close without saving" persists nothing.

Existing profiles re-login through the same wizard, but **warm** — not from a blank browser. When "Log in again"
opens the session, the wizard calls `POST /browser-profiles/:id/restore {sessionId}` (+ MCP `restore_browser_profile`):
the control plane decrypts the profile's saved cookies and seeds them into the fresh session (`seedStorageState`,
the S5 inverse of capture, owner-gated on both profile and session), then the canvas auto-navigates to the profile's
first carried domain. So the owner resumes from their prior state: if the saved login still holds they land
already signed-in and just re-save (refreshing the capture); if it lapsed the site still recognizes the device, so
re-auth is lighter. Best-effort — a restore failure (or an empty profile) just leaves a blank browser to log into.
The decrypted cookies go into the browser, never back to the client (restore returns only the carried domains).
Geo defaults to the profile's country. The interactive **session** exists only inside the wizard (there is no
Browser-sessions settings tab), but proxies now have their own **Settings › Browser › Proxies** page
(`settings:write`-gated; admins register there, and the wizard's geo step still manages the same pool inline; the
`/workspace/proxies` API is unchanged).

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

- **`BrowserProfileSpec`** (`core`): `{ id, name, visibility, country?, proxyRef?, cookieDomains[], createdBy,
  storageStateRef, updatedAt }`. **Dual-scoped** (`visibility`, migration `0069`, mirrors View visibility; the
  "workspace share" this entity anticipated is now realized as an *opt-in*):
  - `private` (default) = a personal profile, visible and manageable only by its creator (user scope — the right
    default for personal login material; NO admin override even for management: a non-creator gets a 404, no
    existence leak).
  - `workspace` = a shared asset: read by any member, managed by the creator or a workspace admin (a non-manager
    gets a 403).
  `list` returns the caller's visible set (all workspace profiles + their own private ones). The gate is uniform
  across update/remove and the capture/restore session ops (same `manageableOrThrow` rule). The encrypted
  `storageState` blob stays server-only, and the interactive session driving capture/restore stays owner-only (you
  can only drive your own live browser). Eval injection (S5) still owner-gates on `job.submittedBy` — cross-member
  use of a profile's login inside evals is a deliberate follow-up, not part of the metadata share. Sharing is an
  explicit toggle in the manager (share private→workspace / make workspace→private, via `visibility` in the update).
  `country` (nullable, migration `0061`) records the geo the login session ran through at creation (S7) — re-login
  defaults to it and the eval-browser proxy launch (follow-up) reads it.
- **`BrowserProfileStore`** (`db`): the metadata; the `storageState` blob lives in `storage` (S3), **encrypted**
  (`secret-cipher`), keyed `(workspace|subject, profileId)`.
- **Capture** (S3): ✅ SHIPPED. `captureStorageState(cdpBase)` (`@everdict/topology`) reads the session's cookies
  via CDP `Network.getAllCookies` → a Playwright-style `storageState`; the apps/api `BrowserProfileCaptureService`
  (`core/browser-profile`) encrypts it (AES-256-GCM, the shared `SecretCipher`) → `store.saveState` persists the
  opaque blob (`state_cipher`, migration `0059`) + `capturedAt` + the refined `cookieDomains`. Owner-gated on both
  the profile and the session; the blob is **server-only** (`loadState` reads it back for S5). Route
  `POST /browser-profiles/:id/capture {sessionId, cookies?}` + MCP `capture_browser_profile` — the optional
  `cookies: [{domain, name}]` narrows the capture to the user's chip selection (S7); omitted = keep everything,
  a selection matching nothing = 400 (never silently store a dead login). `cookieDomains` derives from the
  filtered set. Web: the capture is the "Save
  profile & close" step of the S7 wizard (create profile → capture → close session) + a `capturedAt` badge on the
  profiles list. (localStorage capture via `Runtime.evaluate` is deferred — cookies are the login material for
  most sites.)
- **Proxy / geo** (S4): ✅ SHIPPED (login browser). `WorkspaceSettings.proxies` (BYO per-country pool, like
  image-registries/trace sinks; `{name, country, url, authSecretName?}`, the auth secret a SecretStore name-ref) +
  `ProxyService` (`@everdict/application-control`: list/upsert/remove admin (settings:write) + `resolve(country)` →
  the `--proxy-server` value, folding the auth secret into the URL). Routes `GET /workspace/proxies` (workspace read,
  no role gate — the session geo picker consumes it) + `PUT`/`DELETE` (admin) + MCP parity. The interactive session
  (`BrowserSessionService.create({country})`) resolves the country → the `LocalChromeProvisioner` launches Chrome
  with `--proxy-server`; the web geo picker + inline proxy-pool management live in the S7 wizard's setup step (the
  standalone Settings › Proxies page was removed with S7). **Eval-browser proxy is S5.** Known limit: headless
  Chrome doesn't honor inline proxy *auth* — full authed-proxy support needs CDP `Fetch.continueWithAuth`
  (a follow-up); open proxies + inline-cred setups work today.
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
4. **S2 — profile entity.** ✅ SHIPPED (dual-scoped since the workspace-share follow-up). `BrowserProfileRecord`
   (`@everdict/contracts`) `{ id, tenant, name, visibility, cookieDomains[], createdBy, createdAt, updatedAt }`
   (`visibility` = `private`|`workspace`, migration `0069`, default `private`; the
   `storageStateRef`/`country`/`proxyRef` fields are deferred to the slices that populate them — S3/S4 — per
   no-hypothetical-surface); `BrowserProfileStore` port (`@everdict/application-control`, `list(tenant, subject)` =
   workspace profiles + the caller's own private ones) + `InMemory`/`Pg` impls (`@everdict/db`, migration `0058`,
   `everdict_browser_profiles`) + `BrowserProfileService` (dual-scoped CRUD: get resolves a workspace profile for any
   member and a private one only for its creator; update/remove/capture/restore run one per-visibility gate —
   private = creator-only [404], workspace = creator-or-admin [403] via a `ProfileActor` `{ subject, isAdmin }`, the
   admin override mirroring comments:delete) + `api/browser-profile` routes/docs/MCP parity + the `apps/web`
   `features/manage-browser-profiles` manager (**Settings › Browser › Browser profiles**: create with a scope toggle
   [personal default], per-row scope badge + share/make-personal toggle, per-row re-login/rename/delete for the
   creator or an admin, creator chip on others' shared rows) + `entities/browser-profile` drift-guarded schema +
   ko/en i18n. A profile is a login placeholder until S3 captures cookies into it.
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
   The browser image is a **third-party** dependency (`chromedp/headless-shell`, the chromedp project on Docker Hub —
   we do not build it). It is **pinned by digest** in ONE place — `DEFAULT_BROWSER_IMAGE`
   (`packages/topology/src/deploy/browser-image.ts`, used by the docker/nomad/k8s per-case browsers **and** the S6
   interactive provisioner) — per the infra rule (ban `:latest`, reproducible). `.github/workflows/browser-image.yml`
   mirrors the pinned upstream to `ghcr.io/everdict/headless-shell` (digest-preserving `imagetools create`), so a
   managed / air-gapped deployment can drop the Docker Hub dependency by pointing `EVERDICT_BROWSER_IMAGE` /
   `RuntimeSpec.browserImage` at the mirror. To bump: re-resolve the digest, update `browser-image.ts`, re-run the
   mirror workflow. Follow-up: managed **K8s** reachability (per-session `kubectl port-forward` / ingress to the pod
   CDP) — lifts this from a control-plane-host Docker daemon to the SaaS cluster.
   - **S6b — remote sidecar pool (socket-free, multi-user self-hosted).** ✅ SHIPPED. `DockerBrowserProvisioner`
     assumes the control plane runs **on** the Docker host (it shells out to `docker` and reaches the published port
     at `127.0.0.1`); in the containerized `docker-compose.full` stack the api is itself a container, so that path
     needs the host socket mounted, a `docker` CLI in the image, AND `127.0.0.1:<hostPort>` is the api container's
     loopback — not the host. `PooledBrowserProvisioner` (`apps/api infrastructure`) sidesteps all three: it **leases
     a whole browser** from a fixed pool of already-running `chromedp/headless-shell` sidecars, addressed over the
     compose/cluster network by name (`EVERDICT_BROWSER_PROVISIONER=remote` + `EVERDICT_BROWSER_CDP_POOL`, a
     comma-separated list of CDP bases). No socket, no docker CLI, no `reachableWsUrl` host-port dance (the pool base
     IS the reachable authority). A member is leased to exactly one session at a time — its `/json` + cookie jar are
     that session's alone, so the shipped `openBrowserSession`/`captureStorageState` primitives (which assume a
     dedicated browser) are unchanged. On release the member is **wiped** (`resetBrowserState` in `@everdict/topology`
     — `Network.clearBrowserCookies` + `Storage.clearDataForOrigin` + close extra tabs + blank the page) before it
     can be re-leased; a member whose reset fails is **quarantined**, never re-leased dirty (fail-closed, security
     over availability). Concurrency = pool size (a full pool 429s, composing with the S8 caps); scale by adding
     sidecars (`browser2`, …) to the list. Trade-off: **no per-session geo proxy** (S4) — the sidecars are
     pre-launched, so a country-bound login is rejected on this tier (use the `docker` or Nomad-runtime provisioner
     for geo). This is the recommended provisioner for the containerized compose stack (see the `browser` profile in
     `deploy/compose/docker-compose.full.yaml`).
   **Fonts:** `headless-shell` ships no CJK fonts — Korean/Japanese/Chinese pages render as tofu (verified against
   the pinned image). `EVERDICT_BROWSER_FONTS_DIR` (e.g. `/usr/share/fonts`) bind-mounts a host font directory
   read-only at `/usr/share/fonts/everdict-host` inside the session container (fontconfig scans `/usr/share/fonts`
   recursively); unset = no mount. The container also launches with `--window-size=1280,800` (mirroring
   `LocalChromeProvisioner`) so the screencast surface is sane before the client's first `resize`.
   **Live-view input protocol** (`browser-session-ws`, client→server kinds): `mouse` (incl. `mouseWheel` — the
   canvas forwards wheel deltas — plus `modifiers`/`buttons` bitmasks: shortcuts, shift-selection, and drags),
   `key` (a printable keyDown carries `text` — the Puppeteer model, so remote keydown/keypress/input handlers all
   fire; `modifiers` bitmask Alt=1/Ctrl=2/Meta=4/Shift=8), `navigate`, `compose` (in-progress IME composition →
   CDP `Input.imeSetComposition`, so Hangul forms live in the remote field), `insertText` (composition commit —
   ONE CDP `Input.insertText`, which REPLACES the mirrored composition; per-key char events cannot express
   Hangul), and `resize` (bounded 320–2560 × 240–1600 → `Emulation.setDeviceMetricsOverride`, so the remote
   viewport follows the client canvas 1:1 — no scaling blur, correct hit-testing).
   **Frame backpressure (real-time-ness):** the relay never queues screencast frames behind a slow client — above
   a 256 KiB `bufferedAmount` high-water mark frames COALESCE latest-wins (input/error messages are never
   dropped), so latency stays bounded instead of accumulating. The web canvas mirrors this: one
   `createImageBitmap` decode in flight with newest-wins replacement (data-URL `<img>` decodes could finish out
   of order), the canvas only re-sizes on an actual dimension change (assigning `canvas.width` force-clears), and
   mousemoves coalesce to one per animation frame.
9. **S7 — session-first creation UX + live remembered-login chips.** ✅ SHIPPED. Creating a profile IS the login
   session (see "The creation UX is session-first" above). New endpoint `GET /browser-sessions/:id/state-preview`
   (`BrowserSessionService.statePreview` — injectable `captureState`, default the S3 CDP capture; owner-gated,
   throws NotFound cross-owner) returns the per-domain cookie **names** the session currently holds (values never
   cross the wire) + MCP parity `preview_browser_session_state`. `BrowserProfileRecord.country` (migration `0061`)
   records the creation geo. Web: `features/manage-browser-profiles` gained the `ProfileLoginWizard`
   (name + geo → live canvas + polled chips → save = create+capture+close); `features/interactive-browser` slims to
   the `BrowserCanvas` (the launcher panel is gone); the Settings › Browser-sessions and Settings › Proxies pages +
   nav entries are REMOVED — proxy pool management (`features/manage-proxies`, still `settings:write`) is embedded
   in the wizard's geo step. The `/workspace/proxies` and `/browser-sessions` APIs are unchanged (minus the new
   preview route).
10. **S8 — concurrent-session caps (multi-tenant capacity).** ✅ SHIPPED. Each live session is a real browser
    process/container on the control-plane node, so `BrowserSessionService` bounds the concurrent live count:
    `EVERDICT_BROWSER_MAX_SESSIONS_PER_TENANT` (per workspace) + `EVERDICT_BROWSER_MAX_SESSIONS` (fleet-wide on this
    node). Counted after the TTL sweep and after the owner's own single session is freed (`closeOwned`), so a
    re-create never trips the owner's own limit; exceeding either cap throws `RateLimitError` (429 — a transient
    capacity signal, `data.scope` = `tenant`|`global`), before any browser is provisioned. Unset ⇒ unlimited
    (single-tenant / dev default). This closes the "one tenant exhausts the host" gap; it is NOT network isolation
    between concurrent sessions — that is S9 (each tenant's browser on its own trust-zone runtime). Follow-up: fold
    the count into a store when the session registry goes multi-replica (today the cap is per-node, matching the
    in-memory registry).
11. **S9 — runtime-bound sessions (managed reachability + per-tenant network isolation).** ✅ SHIPPED (Nomad).
    A session's browser can run on a tenant's REGISTERED runtime instead of the control-plane host, which (a) makes
    sessions work when apps/api is itself containerized (full compose / managed K8s — the browser stands up on the
    tenant's cluster and the control plane reaches its CDP over the network, not `127.0.0.1`), and (b) closes the
    cross-tenant CDP-theft gap flagged in S8 — each tenant's session runs in its own **trust zone** (namespace +
    isolation runtime + cross-tenant network deny, `perTenantTrustZones`), so one tenant's live session can't reach
    another's CDP. The seam: `CreateBrowserSessionCommand.runtime` (POST body / MCP `start_browser_session`; absent ⇒
    the host provisioner) → a `RoutingBrowserProvisioner` (`opts.runtime` present ⇒ the `RuntimeBrowserProvisioner`,
    else the S1/S6 host provisioner) → the `RuntimeBrowserProvisioner` resolves the tenant's `RuntimeSpec`
    (404 if unknown), resolves the tenant trust zone, and delegates to an injected `provisionOnRuntime`. The session
    id is minted **before** provisioning so the runtime browser is keyed + rediscovered by it. **Nomad** is the first
    orchestrator (`runtimeSessionProvision` → `NomadTopologyRuntime.provisionBrowserEnv` for a bare per-session
    browser job in the zone's namespace, then `browserCdpBase` for the control-plane-reachable alloc host port; a
    synthetic empty-services `ServiceHarnessSpec` suffices — the browser job reads only `target`). **Reachability by
    runtime** (unchanged intent from the S1 table, now realized): local/host = the host provisioner; **Nomad** =
    published alloc port (shipped); **K8s** = per-session `kubectl port-forward`/ingress (follow-up — the standalone
    provisioner throws a clear "not yet" for non-Nomad); **self-hosted** = the control plane can't dial into the
    user's machine, so it needs a **reverse relay** (the runner brings up a local Docker browser and bridges CDP
    outbound over MCP, like the live-screen frame push) — follow-up. Follow-ups: the K8s + self-hosted paths above,
    a web session runtime-picker (the field is API/MCP-settable today, mirroring how S5's `target.profile` shipped),
    and folding the S8 caps into a store alongside the multi-replica session registry.

## Non-goals / risks

- **Security is the through-line.** A live CDP-driven browser is powerful (navigate anywhere, exec JS) — that is the
  point (the user drives it), so gate it HARD: owner-only ticket, single active session, TTL, isolated egress (trust
  zone). Cookies = login credentials → encrypted at rest, never logged, transient in the browser. The **session**
  stays personal (owner-only); a **profile** is personal by default and only becomes shared on an explicit opt-in,
  and even then only its metadata crosses the wire — the encrypted `storageState` blob is server-only, and
  capture/restore/manage are creator-or-admin (a private profile: creator-only, no admin override), so the login
  material itself is never exposed to the rest of the workspace.
- **Cookie expiry** — profiles go stale. ✅ Surfaced: capture records the profile's expected expiry
  (`BrowserProfileRecord.expiresAt`, migration `0064`) = the EARLIEST wall-clock expiry among the captured cookies
  (`storageStateExpiry` in `@everdict/topology`; a login is only as fresh as its soonest-expiring persisted cookie;
  null when every captured cookie is a session cookie / nothing is captured — not sensitive, so it rides on the
  record unlike the storageState blob). Settings › Browser profiles renders a per-row expiry chip
  (`entities/browser-profile` `profileExpiryStatus`: a quiet date/"Session-based" chip when fresh, a colored
  "Expires in N days"/"Expired" chip inside the `EXPIRY_SOON_DAYS`=7 window, which also promotes the row's
  "Log in again" button) so an owner re-logs in (warm re-login, S3) before an eval would run unauthenticated.
- **Quality** — CDP screencast is modest-fps JPEG; fine for login/navigation, not smooth video.
- **Not a general remote-desktop** — one page target, browser only; no multi-tab orchestration in v1.
