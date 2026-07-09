# Authenticated browser profiles — a real interactive remote browser, cookies reused in eval (design)

> **Status: S0 SHIPPED + live-proven (`a168b5b`). S1+ in slices.** S0 = the interactive live browser session
> primitive (`openBrowserSession`, `@everdict/topology`): CDP screencast (frames OUT, each acked) + input
> (mouse/keyboard/navigate IN), transport-injectable. Proven end-to-end against real Chrome via
> `scripts/live/interactive-browser.mjs` (3 frames streamed + text typed via CDP read back from the real DOM;
> `--serve` renders a canvas so a human drives the browser). The hardest risk — "can we actually serve a real
> interactive browser?" — is retired. What remains is wiring (transport through the control plane), the profile
> entity, cookie capture, geo proxy, and injection into eval runs.

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
- **Capture** (S3): on "save", CDP `Network.getAllCookies` (+ localStorage via `Runtime.evaluate` / `Storage`) →
  Playwright-style `storageState` → encrypt → store; record `cookieDomains`.
- **Proxy / geo** (S4): a `ProxyProvider` (BYO proxy pool registered per workspace, like image-registries/trace
  sinks; country → proxy URL + auth) → `--proxy-server` on both the login browser and eval browsers.
- **Injection** (S5): a browser eval whose case/target references `profileId` → at `provisionBrowserEnv`, **before
  the agent connects**: launch with the profile's proxy, then seed cookies via CDP `Network.setCookies` (+
  localStorage) from the decrypted `storageState`. The agent (browser-use) receives an already-authenticated browser.

## Slices

1. **S0 — interactive session primitive.** ✅ SHIPPED (`a168b5b`), live-proven.
2. **S1a — WS transport through apps/api (local-Docker reachable).** Generic ticket store + `WS
   /browser-sessions/:id` relay (terminal-WS pattern) + a dedicated-interactive-browser provisioner (docker). Live
   scenario: open the WS, drive a real browser, capture nothing yet — proves the productized transport.
3. **S1b — apps/web canvas feature.** `manage-browser-profiles` + the interactive canvas component (the `--serve`
   page, productized: WS instead of SSE/POST). Users drive the browser inside the app.
4. **S2 — profile entity** (`BrowserProfileSpec` + `BrowserProfileStore` + encrypted `storageState` blob).
5. **S3 — cookie capture** on session save (`Network.getAllCookies` → storageState → encrypt → store).
6. **S4 — proxy / geo** (`ProxyProvider`, `--proxy-server`).
7. **S5 — injection into eval** (seed cookies + proxy before the agent connects).
8. **S6 — managed K8s reachability** (port-forward/ingress to the pod CDP) — lifts S1 from local-Docker to the SaaS.

## Non-goals / risks

- **Security is the through-line.** A live CDP-driven browser is powerful (navigate anywhere, exec JS) — that is the
  point (the user drives it), so gate it HARD: owner-only ticket, single active session, TTL, isolated egress (trust
  zone). Cookies = login credentials → encrypted at rest, never logged, transient in the browser, personal scope.
- **Cookie expiry** — profiles go stale; surface staleness + a one-click re-login (re-run S1 + S3).
- **Quality** — CDP screencast is modest-fps JPEG; fine for login/navigation, not smooth video.
- **Not a general remote-desktop** — one page target, browser only; no multi-tab orchestration in v1.
