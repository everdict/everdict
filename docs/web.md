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

## FSD layout (`src/`)
```
app/        Next App Router — landing(/), [workspace]/{layout(shell+membership validation), page(overview), runs, runs/[id],
            harnesses, datasets(+[id],new), scorecards(+[id],new,compare), judges(+[id],new), runtimes(+[id],new),
            account, settings} — Linear-style /{workspaceSlug}/... ; top-level entry points without a workspace slug
            onboarding·new-workspace·invite ; api/auth/[...nextauth] ; middleware(first URL segment → injects x-everdict-active-workspace header)
widgets/    page-level composition: app-shell (sidebar+topbar), workspace-switcher (Linear-style sidebar dropdown:
            current workspace + switch (= navigate to /{workspace}) + "new workspace"), scorecard-summary, runs-table, trace-timeline
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
- **Run detail `/{workspace}/runs/[id]`** — status, meta, scores, **trace timeline**, snapshot, error.
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
  never unmounts it. **The panel navigates itself and is self-sufficient**: infra drill-ins (runtime · runner ·
  schedule · live run) open IN-PANEL (per-tab detail state in the provider, `DetailNav` back row), never via
  the left router — the two halves have fully independent navigation, and there is deliberately NO "full page"
  link (the panel shows the full content itself; routed infra pages stay URL-reachable only). The only
  left-bound links inside the panel are eval-axis entities (scorecards). Tabs: **work** — the queue snapshot:
  per-runtime lanes (default backend · registered
  runtimes · `self:<runner>`) each showing running (batch = case-progress bar), waiting (FIFO, first badged
  'Next') and next-scheduled fires, from `GET /queue` (`runs:read`; MCP parity `get_queue`; see
  `docs/architecture/work-queue.md`); **runs** — the execution feed (BFF `/api/runs`, scope=all) where selecting
  a run swaps in its **uninterrupted live view** (LiveScreen frames + LiveLogs tail) right in the panel — the
  cross-page entry is `useInfraPanel().openRun(id)` (e.g. the work tab's watch-live shortcut on running runs);
  **runtimes** — the infra roster (workspace runtimes + my self-hosted runners with 90s-window online dots, BFF
  `/api/runtimes`); **schedules** — enabled-first upcoming fires (BFF `/api/schedules`). Runtime placement is
  captured on records (`RunRecord.runtime`/`ScorecardRecord.runtime`, mig 0040).
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
- **Workspace settings `/{workspace}/settings`** — admin-gated tabs: General · **Secrets** ·
  **Integrations**(GitHub App · Mattermost) · CI · Shared runners · Members. **Secrets tab**: provider-token curation +
  a **single list** of directly-added secrets — the SecretStore is one flat namespace, so one list (splitting by purpose
  showed the same secrets twice); multi-line values (kubeconfig) are a toggle on the add form, and legacy
  `?tab=model|cluster` deep links land on this tab. **General tab**: the workspace card (`features/workspace-settings`
  `WorkspaceInfoCard`) — logo **file upload** (256px data URL via `shared/lib/image-resize`, same as the user
  avatar) · name edit + **URL(slug) read-only** (copyable; slug=tenant key so immutable) → `PATCH /workspace`. Below it, the usage-metering
  policy (`SettingsForm`), and **owner-only** a danger zone (`features/delete-workspace` `DeleteWorkspaceCard`):
  a hard delete that only enables once you type the workspace name to confirm → `DELETE /workspace` then navigate home (`/`) (the server
  decides visibility by `getWorkspace.owner === principal.subject`; final enforcement is the control plane). The Integrations
  tab (`features/manage-github-app` + `features/manage-mattermost`) manages workspace-owned external integrations:
  **GitHub App** (org install → selected repos → workspace-owned installation tokens: private-repo clone · CI setup-PR · runner
  registration; `GET/POST/DELETE /workspace/github-app*`, repo picker `GET /workspace/github-app/repos`) + **Mattermost**
  (completion/regression notifications + slash commands/buttons; `GET/PUT/DELETE /workspace/mattermost`). `settings:*`=admin.
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
**server actions** (`'use server'`) that forward the user's token and call the control plane server-side, then
`revalidatePath`.

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
