# SaaS web (`apps/web`)

The multi-tenant SaaS frontend — a Next.js app (FSD architecture, **Linear-style** design — refined dark-first
minimalism with a light/dark toggle) where tenant **users** log in (Keycloak), see their **per-tenant scores**,
runs, and harnesses.

## Two complementary auth paths
- **Humans → Keycloak (OIDC)** via Auth.js in `apps/web`. The web is a **BFF token courier, not an auth
  authority**: Auth.js stores (and refreshes) the Keycloak **access token** in the **server-only httpOnly
  encrypted cookie** — it is **never put on the client session** (no `/api/auth/session` leak). The server reads
  it via `getAccessToken()` (`getToken` over the cookie) and `control-plane.ts` forwards it as
  `Authorization: Bearer <jwt>` to `@everdict/api`. The control plane resolves identity — `workspace` + roles come
  from `GET /me`, never decoded from the token by the web. UI is role-gated off `/me` (mirror in
  `shared/auth/can.ts`), but enforcement is always the control plane's (403). Without Keycloak configured the web
  falls back to the dev `x-everdict-tenant=default` path. See `docs/auth.md`.
- **Agents / MCP / CI → MCP or API keys**: the agent-facing **MCP server** (`@everdict/api` `/mcp`) exposes
  run/harness tools, OAuth-protected via Keycloak ("login like Linear MCP") or an `Authorization: Bearer ak_…`
  API key — same auth core, role-gated. See `docs/mcp.md`.

These don't conflict: Keycloak = people in the browser, API keys = machines. Both resolve to the same
control-plane `Principal{workspace, roles}`.

## i18n
UI copy lives in next-intl catalogs `messages/{ko,en}.json` — components never hardcode user-facing
strings (`useTranslations()` client / `getTranslations()` server). The locale is **cookie-based**
(`everdict-locale`; `shared/i18n/request.ts` resolves cookie > `Accept-Language` > `en`) — there is **no
`/[locale]` URL segment**, because the first path segment is the workspace (Linear-style). The
switcher (`features/switch-locale`) sits in the sidebar footer and persists the cookie via a server
action. Migration is incremental per slice; `widgets/app-shell` is the reference. New strings go to
**both** catalogs in the same PR.

## Stack
Next.js 16 (App Router) · React 19 · TypeScript · Tailwind v4 (`@theme inline` tokens) · shadcn-style UI
(new-york, neutral base, **Linear-style** indigo `#5e6ad2` primary + tight `0.5rem` radius + near-black dark
surface; light/dark toggle via `shared/ui/theme-toggle`, no-flash inline script in `layout.tsx`) · TanStack
Query · zod · Auth.js + Keycloak. Self-contained tooling: **eslint + prettier** (import-order plugin) — NOT the repo Biome (apps/web is
excluded from root Biome). The web is a pure HTTP client of the control plane — **runtime-decoupled: the only allowed
`@everdict` dep is TYPE-ONLY `@everdict/contracts`** (wire/record TYPES, re-architecture P4). Local zod v4 schemas keep
doing all runtime validation; exported types are anchored to the contract types via a compile-time drift guard, so the
schemas can't silently diverge from the control plane. `import type` only (no value/schema import — zod v3 never runs in
the web); `@everdict/contracts` is the ONLY permitted `@everdict` dependency.

**Outbound proxy (corporate networks).** The web server's few external calls (the desktop-releases GitHub fetch) honor
standard `HTTP(S)_PROXY` / `NO_PROXY` env: `src/instrumentation.ts` installs an undici `EnvHttpProxyAgent` global
dispatcher at boot (`shared/lib/proxy-dispatcher.ts` — the local mirror of `apps/api`'s, kept in-app because of the
runtime-decoupling rule). No proxy env → no-op. The compose stacks pass the proxy env through at runtime and append
compose-internal service names to `NO_PROXY` so web→api never routes through the corporate proxy
(`deploy/compose/*.yaml` `x-runtime-proxy-env`); a TLS-intercepting proxy's CA rides on `NODE_EXTRA_CA_CERTS`.

## FSD layout (`src/`)
```
app/        Next App Router — landing(/), [workspace]/{layout(shell+membership validation), page(overview), runs, runs/[id],
            harnesses, datasets(+[id],new), scorecards(+[id],new,compare), judges(+[id],new), runtimes(+[id],new),
            account, settings} — Linear-style /{workspaceSlug}/... ; top-level entry points without a workspace slug
            onboarding·new-workspace·invite ; api/auth/[...nextauth] ; middleware(first URL segment → injects x-everdict-active-workspace header)
widgets/    page-level composition: app-shell (sidebar+topbar), workspace-switcher (Linear-style sidebar dropdown:
            current workspace + switch (= navigate to /{workspace}) + "new workspace"), scorecard-summary, runs-table
            (trace reading is NOT a widget — the one surface is features/browse-traces TrajectoryView, whose
             SpanWaterfall is shared with the external platform's trace dialog; see Run detail)
features/   business actions: submit-run, register-harness, register-dataset, run-scorecard, register-judge, compare-scorecards, register-runtime, ingest-scorecard, create-workspace, manage-workspace-secrets, manage-github-app + manage-mattermost (workspace-owned integrations: GitHub App org install→selected repos, Mattermost notifications/slash commands) (client form/action → control plane; workspace switching is a URL navigation, so there is no separate action)
entities/   domain models + zod schemas mirroring the API (run + trace/snapshot, harness, dataset, scorecard, judge, runtime, workspace, secret, github-app, mattermost)
shared/     ui (button/card/badge/page-header/stat-card/status-pill/empty-state/callout/section-header/theme-toggle), lib (utils, control-plane),
            config (env), providers (query), auth (Keycloak token store/refresh, server-only access-token (getToken),
            authContext + currentPrincipal + can, workspace-scope(URL↔cookie↔header constants) + active-workspace cookie → x-everdict-workspace)
```
Import order enforces downward layer deps (app → widgets → features → entities → shared).

**Dropdowns are always `shared/ui/combobox` (`Combobox`)** — the native `<select>` atom was removed from
`shared/ui/input` and `<datalist>` suggestions were replaced too, so every picker (list sort/filter bars, form
fields, react-hook-form via `Controller`) opens the same Linear-style popover (search, keyboard nav, hints).
`<optgroup>` has no popover equivalent — encode the group as each option's `hint` (e.g. runtime picker's
"my local host", benchmark import's "catalog / my recipes").

**Guide/help copy is never inline** — explanatory guidance (e.g. "edits are deployed as a new version") must not sit
as visible caption text in panels; render a small info icon via `shared/ui/tooltip` (`InfoTip`, or `Tooltip`
around any trigger) and reveal the copy on hover/focus. Field-level `<p>` hints under form inputs are fine;
panel/list guidance is not.

## Screens
- **Workspace switcher** (sidebar top, every screen) — the current-workspace (name+role) dropdown switches between
  the workspaces I belong to (= navigate to `/{id}`; the first URL segment is the authority for the active workspace, the middleware syncs the cookie) + **new workspace**
  (`/new-workspace` → `create-workspace`, the creator is admin). The list and active workspace are authoritative from `GET /me.workspaces`. See `docs/tenancy.md`.
- **Overview `/{workspace}`** — scorecard stat cards (total / success / fail / pass-rate) + recent runs + harness summary.
- **Runs `/{workspace}/runs`** — full runs table (rows link to detail). Like schedules/runtimes, not linked
  from the UI at all — the infra panel is THE surface for infra concerns (sidebar is eval-only, the palette's
  infra group opens the panel); the route remains URL-reachable only.
- **Run detail `/{workspace}/runs/[id]`** — the ledger holds five executable families, so the page is a shared
  skeleton with ONE slot that swaps per `kind`: identity meta (whose two axes are relabelled per kind — an agent
  turn's harness column IS its agent spec, a sandbox's caseId IS its image) · request (`caseSpec.task`) ·
  **outcome** (eval = the served `verdict` + a metric table whose rows expand to the grader's reasoning, failures
  open by default; agent = the activation cause + "open conversation"; sandbox = image · TTL · teardown reason) ·
  **evidence** (`TrajectoryView`, the SAME component Settings › Observability opens a sealed trajectory with) ·
  snapshot · comments. Live panels (logs/terminal) render only for the channels the run DECLARES in `attach`.
  Every section hides entirely when empty — "no scores yet" on a run family that can never have scores was the
  bug this replaced. Causation (`origin.causedByRunId`) and the group (scorecard/conversation/session) link out.
- **Harnesses `/{workspace}/harnesses`** — owned vs `_shared` harnesses with versions. **Detail
  `/{workspace}/harnesses/[id]`** shows the active version's **Config panel** — the raw, editable config
  (template-category ref `id@version` + slot→value pins, via `GET /harnesses/:id/:version/instance` +
  `GET /harness-templates/:id/:version`) above the resolved spec views (diagram / structure / JSON). A **"new
  version"** action (`/{workspace}/harnesses/[id]/new-version`) prefills the current config into the register
  wizard — versions are immutable, so editing = registering a new version (re-pin the instance pins → new instance tag,
  or a template structure → new template semver, then re-pin an instance on it).
- **Datasets `/{workspace}/datasets`** — a **searchable, metadata-rich** list: each row shows description, all
  versions, latest-version case count, tags, **related harnesses** (joined from scorecards), the **author**
  (`createdBy` resolved to a member name) and created/updated times, plus an owned/shared badge. A client widget
  adds **search** (id/description/tags), an **owner filter** (all/owned/shared), and **sort** over a stat strip
  (first-party example datasets are no longer auto-seeded, so the list is the workspace's own datasets). **Detail
  `/{workspace}/datasets/[id]`** shows a **meta panel** (case/version/scorecard counts, created/updated, author
  avatar, tag chips — not a bare dl grid) above the eval-case table, plus a **"new version"** action
  (`/{workspace}/datasets/[id]/new-version`, owned datasets + `datasets:write` only) that prefills the current
  version's description/tags/cases into the register form — versions are immutable, so **editing = publishing a
  new semver** (same pattern as harness new-version). **Dataset registration `/{workspace}/datasets/new`** —
  id/version/description/tags + cases-JSON with a **validate (dry-run)** step then register (`POST /datasets`;
  server-action body limit raised to 8MB — embedded repo-seed cases easily exceed 1MB). Role-gated off `/me`
  (`datasets:write` = member+). See `docs/datasets.md`.
- **Scorecards `/{workspace}/scorecards`** — batch-eval runs (dataset@v → harness@v, status, per-metric summary
  chips; rows link to detail). **Detail `/{workspace}/scorecards/[id]`** shows per-metric stat cards + per-case
  scores. **Run `/{workspace}/scorecards/new`** — pick dataset + harness (+ optional judges) → `POST /scorecards`.
  **Compare `/{workspace}/scorecards/compare`** — two scorecard pickers → metric Δ table + regressions/improvements
  (`diffScorecards`). **Ingest `/{workspace}/scorecards/ingest`** — push|pull toggle: **push** uploads externally-run
  `TraceEvent[]`; **pull** fetches from a tenant's OTel/MLflow (`source` + `runs:[{caseId,runId}]`, auth-secret name).
  Both produce a scorecard with no harness run. Role-gated off `/me` (run/ingest = member+, read/compare = viewer+).
  See `docs/scorecards.md`.
- **Infra panel (split view, `widgets/infra-panel`)** — infra concerns (schedules · runtimes · runs · work
  queue) don't live on the left with the eval pages: a **vertical rail** of toggle buttons (vertically centered,
  the divider between the eval half and the infra half) opens a **floating right panel** (rounded, gapped,
  pop-shadow card — not a flush docked column) as a flex sibling of `main`, so the two sides split the space
  half-and-half on md+; on mobile the rail floats on the right edge and the panel becomes a floating sheet.
  Panel state + polling live in `InfraPanelProvider` in the shell (above the routes), so left-side navigation
  never unmounts it. **The page tabs host the REAL routed pages** (user decision — no re-implemented
  summaries): schedules · runtimes · runs are same-origin iframes of `/{ws}/schedules|runtimes|runs` rendered
  chrome-less — the [workspace] layout passes an embed hint (sec-fetch-dest=iframe, only sent on trustworthy
  origins, OR the panel's `?embed=1` promoted to `x-everdict-embed` by the middleware) to `ShellSwitch`
  (client), whose framed decision is STICKY because the dynamic layout re-renders on soft nav without those
  signals; `EmbedShell` renders the page bare. Each iframe owns its navigation (fully independent right-side
  navigation: list → detail, live 20s cluster polling, run detail with trace/logs/screen — the full existing
  screens) and stays mounted across TAB SWITCHES while the panel is open, so flipping tabs or navigating the
  left half never interrupts a live view; CLOSING the panel discards the page iframes, so reopening renders
  each tab fresh (also the recovery gesture for any stuck frame). The panel header's **back button** walks a
  parent-tracked per-tab path stack (`EmbedShell` reports infra routes via `everdict:frame-nav`; back = a hard
  `contentWindow.location.replace` to the previous entry, home as the final fallback) — NEVER
  `history.back()`, which traverses the top-level joint session history and could undo a left-side navigation.
  Framed pages never compute their own theme: the layout's inline script adopts the parent's `html.dark` at
  load and `EmbedShell` mirrors it live via a MutationObserver (the parent is the single theme authority). A
  dead session never renders the sign-in flow inside the panel: the middleware 401-escapes embed requests, and
  the [workspace] layout covers the remaining case (session cookie decodes but the control-plane exchange
  fails → `FrameEscape` sends the TOP window to sign-in instead of redirecting the iframe).
  Eval-axis links clicked inside an iframe (anything but runs/runtimes/schedules) are intercepted by
  `EmbedShell` and posted to the parent (`everdict:left-nav`) → the LEFT router navigates instead. Deep entries
  `useInfraPanel().openRun/openRuntime/openSchedule` point the tab's iframe at the entity's real page. The
  **work** tab stays purpose-built (no full page): the queue snapshot per-runtime lanes (default backend ·
  registered runtimes · `self:<runner>`) with running (batch = case-progress bar), waiting (FIFO, first badged
  'Next') and next-scheduled fires, from `GET /queue` (`runs:read`; MCP parity `get_queue`; see
  `docs/architecture/work-queue.md`); its run rows open the run's real page in the runs tab. Runtime placement
  is captured on records (`RunRecord.runtime`/`ScorecardRecord.runtime`, mig 0040). The **files** tab is also
  purpose-built (no iframe, no rail button): Settings › Files selects a workspace-filesystem path via
  `useInfraPanel().openFile(path)` and the panel renders it interactively (`FileViewer` chrome over
  `DocumentPreview` — prose, CSV grid, code in ~35 languages, images, PDF, media, and a download for anything
  the browser cannot show; member editing); re-selecting swaps content in place, and a panel-side mutation bumps
  `fsRevision` so the selecting tree refetches. **Entry actions live on the tree, not in the viewer** (which
  only reads and edits): moving is drag-and-drop (drop on a folder row, or on the tree body for the top level;
  invalid drops refused at `dragover` and re-checked at `drop`) or the multi-select "Move to…" folder picker,
  and deleting is the row trash / bulk delete. Multi-select follows the scorecard-list grammar (hover-revealed
  checkboxes, shift-click ranges, Esc clears, floating action bar) and a drag from a checked row carries the
  whole selection; `rewriteMovedPath` re-points an open selection a move carried along and `coversPath` closes
  one a delete removed (see `docs/architecture/workspace-filesystem.md`). The **knowledge** tab is the same shape for the
  knowledge map: Settings › Knowledge is a force-directed graph (canvas-2D — pan / zoom / drag a node / search /
  per-type filter chips) of the workspace's claims and skills over the entities they concern; picking a node calls
  `useInfraPanel().openKnowledgeNode(id)` and the panel shows what that node IS (type, version, harvested attrs, a
  claim's markdown body via `/api/knowledge/entries/[id]`) plus its relationships grouped by predicate — rendered
  from the graph the screen published, so map and detail always agree; picking a neighbour there re-centres the map
  (see `docs/architecture/knowledge-graph.md`).
- **Judge `/{workspace}/judges`** — owned vs `_shared` Agent Judges (kind + version chips; rows link to detail).
  **Detail `/{workspace}/judges/[id]`** shows kind + fields + rubric. **Register `/{workspace}/judges/new`** — a
  **kind-toggle form** (model | harness) with a validate (dry-run) step → `POST /judges`. Role-gated off `/me`
  (`judges:write` = member+). See `docs/judges.md`.
- **Runtimes `/{workspace}/runtimes`** — the single **"where evals run"** surface (opened from the infra rail's
  runtimes tab / palette — not a sidebar entry):
  ① **registered infra** — tenant execution infra (nomad | k8s; push — the control plane connects),
  no auto-seeded defaults; ② **connect my machine (self-hosted runner)** — the personal self-hosted runners section
  (RunnersManager moved here from the account page: desktop one-click pairing, presence, revoke, download CTA;
  runners stay subject-owned — only the management entry point moved). **Register
  `/{workspace}/runtimes/new`** — kind-toggle form → `POST /runtimes` (role-independent — any member registers; credentials
  via secrets, not the spec) with `authSecret`/`server`/`kubeconfigSecret` fields + a **test connection** button (nomad/k8s) that runs
  the live probe (`POST /runtimes/probe`) to confirm the cluster actually responds before committing. The scorecard
  run form gains a runtime selector. See `docs/runtimes.md`.
- **Sidebar teams section** (`widgets/app-shell` `TeamsNav`) — Linear's "Your teams": the teams the signed-in
  member belongs to, each expanding to what that team owns under its own path (`/{workspace}/team/ENG/issues`,
  `…/triage` when the team turned one on, `…/cycles`, `…/projects`) plus an **Evaluation** disclosure holding what
  the team evaluates with — `…/scorecards`, `…/harnesses`, `…/datasets`, `…/judges` (`TEAM_EVAL_SECTIONS`; those four
  all carry a registry `team_id`, so the team is where they live, and the workspace-wide lists stay as the other
  address onto the same collection). It is a disclosure for the same reason `Workspace › More` is one: eight flat rows
  per team turn the group into a wall in front of the issues. It auto-expands on any of its own pages and remembers
  the toggle PER TEAM. There is no "Home" row: the
  team's short address (`/{workspace}/team/ENG`) IS its issue list — same component, canonical `…/issues` twin —
  so `matchTeamPath` reads the bare path as `issues` and one destination never gets two nav rows. The active row is decided by the
  PATH alone now — the group used to read `?team=` off the query string, which meant two different judgements for
  "which team am I looking at". A single-team workspace still shows the group (expanded — there is nothing to choose
  between): hiding it hid the fact that issues belong to a team at all, and the key is already baked into `ENG-12`.
  The list is fetched once in `[workspace]/layout.tsx` and threaded through `ShellSwitch` → `AppShell`
  → `Sidebar`; a failed read degrades to no section rather than breaking the shell. The issue list carries the matching
  key chips and the create dialog a team picker (both appear only past two teams), and every issue reads as `ENG-12` —
  the identifier is stored on the record, so neither surface re-reads the team to render it.
- **Workspace settings `/{workspace}/settings`** — admin-gated tabs: General · **Secrets** ·
  **Integrations**(GitHub App · Mattermost) · CI · Shared runners · Members · **Teams**.
  **Teams tab** (`features/manage-team`, `teams:read` to see / `teams:write` = admin to change): the settings-list of
  teams — each row is a drill-in to `/settings/teams/{key}` (the same slug the working screens use) (key badge · name · default chip on the left, roster size +
  open issues on the right). The detail is the team's General block (key READ-ONLY — it is baked into every identifier
  the team has minted — name/description, and "make default" which hands the flag over) plus its **roster**, which is
  separate from workspace membership: belonging to a team is what puts its issues in your list. Deletion is offered
  but the server refuses the default team, the last remaining team, and a team that still holds issues — the reason is
  surfaced verbatim rather than pre-hidden. Reading the list is also the invariant's repair point: a workspace that has
  never had a team gets its default from that read. See `docs/tracker.md` § Team. **Secrets tab**: provider-token curation +
  a **single list** of directly-added secrets — the SecretStore is one flat namespace, so one list (splitting by purpose
  showed the same secrets twice); multi-line values (kubeconfig) are a toggle on the add form, and legacy
  `?tab=model|cluster` deep links land on this tab. **General tab**: the workspace card (`features/workspace-settings`
  `WorkspaceInfoCard`) — logo **file upload** (256px data URL via `shared/lib/image-resize`, same as the user
  avatar) · name edit + **URL(slug) read-only** (copyable; slug=tenant key so immutable) → `PATCH /workspace`. Below it, the usage-metering
  policy (`SettingsForm`), and **owner-only** a danger zone (`features/delete-workspace` `DeleteWorkspaceCard`):
  a hard delete that only enables once you type the workspace name to confirm → `DELETE /workspace` then navigate home (`/`) (the server
  decides visibility by `getWorkspace.owner === principal.subject`; final enforcement is the control plane). The Integrations
  tab (`features/manage-github-app` + `features/manage-mattermost`) manages workspace-owned external integrations as an
  **icon tile grid** (the roster keeps growing, so each integration is a brand-tinted glyph + name + connection count;
  clicking a tile expands its manager in place below the grid — never a drill-in route):
  **GitHub App** (org install → selected repos → workspace-owned installation tokens: private-repo clone · CI setup-PR · runner
  registration; `GET/POST/DELETE /workspace/github-app*`, repo picker `GET /workspace/github-app/repos`) + **Mattermost**
  (MULTIPLE connections — one bot + channel per team/purpose, list + add/edit form keyed by name; completion/regression
  notifications go to every connection that has a channel, plus slash commands/buttons;
  `GET/PUT /workspace/mattermost` + `DELETE /workspace/mattermost/:name`. The server URL is operator env and is never
  shown or entered — it only decides whether the integration is available at all). `settings:*`=admin.
  See `architecture/workspace-scoped-integrations.md`.
- **Account `/{workspace}/account`** (personal — self-scoped, no role gate) — Profile · **Personal secrets** ·
  **API keys** tabs (`account-tabs.tsx`). Personal outbound-OAuth "connected accounts" was removed (S6c) — external integrations are
  unified into the workspace-owned GitHub App/Mattermost (Settings › Integrations, See `architecture/workspace-scoped-integrations.md`);
  personal runner management (`features/manage-runners`) moved to the runtimes page (see above).
- **Download `/{workspace}/download`** (`features/download-desktop`) — the desktop-installer download page.
  The server reads GitHub releases (kept private) via a server-only PAT (`DESKTOP_RELEASES_REPO`/`DESKTOP_RELEASES_TOKEN`,
  5-min cache) and renders an OS-detected (UA) recommended button + a list of all platforms + post-install guidance (including an unsigned caveat).
  For the actual download, the `GET /api/desktop/download?id=…` route checks the session (`currentPrincipal`) + validates that it is one of our release
  assets, then 302s to GitHub's signed temporary URL — the large file never passes through the web server, and the token never leaves
  for the client. When the token is unset, it falls back to the `DESKTOP_DOWNLOAD_URL` external link. See `docs/architecture/desktop-app.md`. **Inside the desktop shell** (detected via `window.everdictDesktop` —
  the local mirror type in `shared/lib/desktop-bridge.ts`; the web does not depend on `@everdict/*`), a one-click **"connect this device as a runner"**:
  label = hostname automatically; the token is never shown on screen and descends only through the bridge (stored in the OS keychain); the "this device" row
  uses the bridge's **live status** (running (n)/online + live capability, a "no docker" hint) instead of estimating from
  lastSeenAt, and on unpair it also cleans up the desktop token. For browser users, a
  desktop-app download link appears when `DESKTOP_DOWNLOAD_URL` is set. See `docs/architecture/desktop-app.md` +
  `docs/architecture/self-hosted-runner.md`.
- **New run `/{workspace}/runs/new`** — submit-run form (react-hook-form) → `submitRunAction` (server action) →
  control plane `POST /runs` → redirect to the run detail.
- **Harness registration `/{workspace}/harnesses/new`** — a **structured wizard** (`features/register-harness`): pick
  kind, fill id/version and (for `service`) `services[]`/`dependencies[]`/`frontDoor`/`traceSource`/`target` via
  field arrays, with a **dry-run validate** step (`validateHarnessAction` → `POST /harnesses/validate`: schema +
  existing versions/conflict, no write) + a JSON preview + a raw-JSON mode toggle, then register
  (`registerHarnessAction` → `POST /harnesses`, 409 on the immutable-version violation). Validate + register are
  the same operations exposed on the API and MCP (`docs/mcp.md`).
The **New run** and **Harness registration** pages (and their list-page CTAs) are role-gated off `/me`: a viewer sees a
"You don't have permission" notice instead of the form, a member can submit runs, only an admin can register harnesses.
All under a shared app shell (sidebar nav + topbar **workspace + role** chip / sign-in-out). Mutations are
**server actions** (`'use server'`) that forward the user's token and call the control plane server-side; the
screen is then refreshed by the CALLER's `router.refresh()`.

### A mutation must not hold the screen

A mutation here is a server action plus a refresh, and BOTH halves had to be taken out of the caller's
transition before the screen would keep up. The user-visible symptom was a property change on the issue
detail that took **4–15 seconds** to appear — with the server change committed in ~130 ms, the network
finished under a second, and the main thread completely idle the whole time.

Three things were wrong, in the order they were found:

1. **`revalidatePath` in a mutation action.** Nothing here caches (every page is `force-dynamic`, every
   control-plane call is `cache: 'no-store'`, `staleTimes.dynamic` is 0), but in Next 16 an action that
   merely *declares* a revalidation makes the router run `invalidateEntirePrefetchCache()` and start a
   300 ms cooldown. Actions no longer call it — see the note at the top of each `features/*/api` module.
2. **Every `<Link>` re-prefetching.** A refresh invalidates the segments the current route shares with every
   other route — the workspace layout — so each one re-prefetched through a scheduler capped at four
   concurrent requests: 49 RSC requests for one click. On a `force-dynamic` route a prefetch only warms the
   shell the screen is already rendering, so the app has ONE link component — `shared/ui/link` — which
   defaults `prefetch` to `false` (an eslint `no-restricted-imports` rule keeps `next/link` out of
   everything else). Navigation is unchanged to the eye: click → URL 36 ms, content 335 ms, the loading
   boundary covering the gap.
3. **The refresh, and everything after the `await`, living inside the caller's transition.** This was the
   decisive one. `startTransition(async () => { await action(); setOpen(false); router.refresh() })` leaves
   those updates entangled with the router's work, and the commit then happens *whenever*: eight identical
   assignments measured 26 · 158 · 4691 · 9754 · 9757 · 14765 · 4754 · 235 ms. What actually released it was
   an **unrelated** update — a poller tick, or the user clicking anything — which is why the delay tracked
   the ~5 s poll interval. Nudging on purpose at 300 ms flattened the same eight to 328–380 ms.

So mutations do not run in a transition. `pending` is plain `useState`, the action is awaited in a plain
async IIFE, and the refresh goes through **`shared/lib/use-refresh`** (`useRefresh()`), which defers
`router.refresh()` by a tick — out of any transition — and then wakes the pending commit a bounded number of
times. Guarded by `shared/lib/use-refresh.test.tsx` and `features/manage-{issue,project}/api/*.test.ts`.

After: the control settles in **41 ms** and the server-rendered half of the page (history feed, the project
detail's `h1`) in **165–195 ms**, run after run. A control whose value is worth showing before the page
catches up can also hold the accepted value locally — `IssueProjectControl` is the reference.


The dev server runs on **port 3001** (`pnpm --filter @everdict/web dev`).

## Run
```bash
pnpm install
# control plane (separate terminal): pnpm build && pnpm api   (loads apps/api/.env; or DATABASE_URL for Postgres)
# Keycloak (optional; without it the web runs in dev mode as tenant "default"):
docker compose -f deploy/keycloak/docker-compose.yaml up -d        # then configure realm/client (see file)
cp apps/web/.env.example apps/web/.env                              # set CONTROL_PLANE_URL + Keycloak vars
pnpm --filter @everdict/web dev                                       # http://localhost:3001
```
Without Keycloak configured, `/{workspace}` (dev: `/default`) renders for the dev `default` workspace (no login
required) — handy for local dev. With Keycloak configured, `/{workspace}/*` is protected (middleware redirects to
login) and the workspace/roles come from the control plane's `GET /me` over the forwarded token.

**Linear-style workspace URLs.** The URL's first path segment **is** the active workspace (`/{workspaceSlug}/runs`).
The `middleware` injects that segment as the `x-everdict-active-workspace` request header (and syncs the most-recent
`everdict-workspace` cookie); `authContext` reads the header (cookie fallback) and forwards it as `x-everdict-workspace`,
so every page/action scopes to the URL workspace with no per-page param threading. Switching workspace = navigating
to `/{id}`. `onboarding`/`new-workspace`/`invite` are slug-less top-level routes (no workspace context yet).

**Auth-exchange gating (entry routing).** The control plane is the auth authority, so the web routes on what
`GET /me` returns, not just on the Keycloak session:
- **Home `/`** — if `GET /me` confirms a real login (`principal.via === 'oidc'`), the landing is skipped and the
  user is redirected to `/{workspace}` (their **most recent**, from `principal.workspace`); 0 workspaces →
  `/onboarding`. A `null` principal (control plane unreachable / token rejected) or the dev `x-everdict-tenant`
  fallback (`via !== 'oidc'`) keeps the landing visible — no loop.
- **`/{workspace}/*`** — `[workspace]/layout` is the authoritative validator: `principal === null` (token rejected
  / control plane unreachable) → redirect to `/`; 0 workspaces → `/onboarding`; the URL slug is not one of my
  memberships → redirect to my default `/{principal.workspace}`; else render the app shell.

**Production (`next start`) gotchas** — the config bakes `trustHost: true` (self-hosted; otherwise Auth.js
throws **`UntrustedHost`** 500 on every `/api/auth/*`). For real Keycloak login you still must set **`AUTH_SECRET`**
(`openssl rand -base64 32`) plus the `KEYCLOAK_*` vars and run the control plane (`CONTROL_PLANE_URL`); a stable
`AUTH_SECRET` is required or sessions reset on restart. With Keycloak unconfigured, `/api/auth/*` uses a throwaway
dev secret so it doesn't 500.

## Verified
`next build` compiles + type-checks (9 routes); root gate (Biome / turbo typecheck / test) stays green with
`apps/web` self-contained. **Live (headless OAuth, real Keycloak)** via `scripts/live/web-auth-flow.py`: drives
the Auth.js + Keycloak authorization-code flow with a cookie jar (no browser) for `alice` (member) and `carol`
(admin) → the web forwards each user's token → `/{workspace}` (=`/acme`) shows `workspace=acme` (from `/me`);
`/acme/runs/new` is allowed for both; `/acme/harnesses/new` is gated for the member and allowed for the admin.
**BFF hardening proven**: the
same script asserts `/api/auth/session` carries **no** access token (no `eyJ…`/`accessToken` leak) while the
server-side path still works — the token lives only in the httpOnly cookie.
