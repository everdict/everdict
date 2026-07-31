---
name: web
description: The SaaS web app (apps/web) — Next.js 16 App Router, FSD layers, a pure-HTTP token-courier BFF over the control plane with Linear-style [workspace] URL scoping. Use when editing apps/web (Next.js FSD web app).
allowed-tools: Read, Grep, Glob, Edit, Write, Bash
---
# Web (apps/web) — Next.js FSD BFF

The multi-tenant frontend. A **pure HTTP client** of `@everdict/api` (no `@everdict/*` deps) and a **token
courier, not an auth authority**: it forwards the user's Keycloak token and trusts the control plane.

## Checklist
1. **Layer down only**: `app → widgets → features → entities → shared` (`src/`). Never import upward.
   Cross-slice imports go through a slice's barrel `index.ts`, never deep paths.
2. **Mirror API shapes with local zod** in `entities/<name>/model/schema.ts` (no `@everdict/*` import);
   `.parse()` every control-plane response. Re-export via the entity's `index.ts`.
3. **All control-plane calls are `server-only`** via `shared/lib/control-plane.ts` (`controlPlane.*`) —
   never fetch from the browser. Pass `AuthContext` from `authContext()` / `currentPrincipal()`.
   Server-side outbound fetch is proxy-aware: `src/instrumentation.ts` installs an `EnvHttpProxyAgent`
   global dispatcher (`shared/lib/proxy-dispatcher.ts`, local mirror of apps/api's — runtime-decoupling
   forbids importing it) so corporate-proxy deployments work via standard `HTTP(S)_PROXY`/`NO_PROXY` env.
4. **Pages = server components** that fetch + `.parse()` and pass plain props to `'use client'` islands;
   mutations are `'use server'` server actions that forward the token then `revalidatePath`.
5. **Role-gate UI** with the `shared/auth/can.ts` mirror (`can(roles, action)`) — enforcement is still the
   control plane's (403). Hide the CTA; don't rely on it for security.
6. Web is SELF-CONTAINED (own eslint/prettier, excluded from root Biome/turbo). Tooling:
   `pnpm --filter @everdict/web {dev,build,lint}` (dev = port 3001). **Never run repo-wide formatters** in
   this shared WIP tree — format only files you changed.

## Reference impl
A full slice: `features/submit-run/` — `ui/submit-run-form.tsx` (`'use client'` react-hook-form island) +
`api/submit-run.ts` (`'use server'` action → `controlPlane.submitRun` → `revalidatePath`) exposed via
`index.ts`; the page `app/[workspace]/runs/page.tsx` fetches server-side and gates the CTA with `can(...)`.

## Auth = token courier (BFF), not authority
- Auth.js keeps the Keycloak access token in a **server-only httpOnly cookie**, NEVER on the client
  `session` (no `/api/auth/session` leak). Read it server-side via `getAccessToken()`
  (`shared/auth/access-token.ts`); `control-plane.ts` forwards `Authorization: Bearer <jwt>`.
- `workspace` + roles come ONLY from `GET /me` (`currentPrincipal()` in `shared/auth/principal.ts`) —
  NEVER decode the token. Dev (no Keycloak) falls back to `x-everdict-tenant=default` (`via !== 'oidc'`).
- Actions/pages: `authContext()` for a mutation, `currentPrincipal()` when you also need `principal`.

## `[workspace]` URL scoping (Linear-style)
The URL's first path segment **is** the active workspace. `middleware.ts` injects it as the
`x-everdict-active-workspace` header (constants in `shared/auth/workspace-scope.ts`, non-`server-only` so
middleware can import it) + syncs the `everdict-workspace` cookie; `authContext()` reads the header and
forwards `x-everdict-workspace`. So there is NO per-page `params` threading for scope — don't reintroduce a
cookie-only path. `app/[workspace]/layout.tsx` is the authoritative validator (redirect on null principal
/ 0 workspaces / non-member). Nav hrefs are workspace-relative **suffixes** (`widgets/app-shell/ui/nav-config.ts`),
prefixed at render; switching workspace = `router.push('/'+id)`. Slug-less entry points stay top-level
(`RESERVED_TOP_LEVEL`: `onboarding`/`new-workspace`/`invite`/`api`).

## Styling
Tailwind v4 tokens in `app/globals.css` `@theme inline` (Linear indigo `#5e6ad2`, tight `0.5rem` radius,
near-black `#08090a` dark surface). Light+dark via the `.dark` class (`@custom-variant dark`) toggled by
`shared/ui/theme-toggle` — NO `next-themes`; no-flash inline script in `app/layout.tsx`. `cn()` from
`shared/lib/utils.ts`; shadcn new-york atoms under `shared/ui/`. Dropdowns are always `shared/ui/combobox`.

## Established UI conventions (enforced — reuse, don't reinvent)
- **Format atoms**: score/model/version/time formatting goes through `shared/lib/format.ts` +
  `shared/ui/{score,chip}.tsx`, NEVER per-page inline.
- **Charts** = `shared/ui/charts` (`LineChart` / `BarChart` [grouped+stacked] / `RankedBars`), never a
  new hand-rolled SVG. The family owns the axis, the nice-rounded ticks, the recessive hairline grid, the
  hover/focus tooltip and the legend, so a chart cannot invent its own chrome. **Colors come only from
  `palette.ts`** (`--chart-1..5` + `--chart-other` in `globals.css`, stepped per surface and validated as a
  set for CVD/contrast — re-run the validator if you touch them): slots are assigned in FIXED ORDER from a
  stable, *unfiltered* key list (color follows the entity, so filtering never repaints survivors), and past
  `MAX_SERIES` the tail folds into "other" or is dropped WITH a visible note — never a generated 6th hue.
  Ratio measures pin the domain to `{min: 0, max: 1}`; everything else auto-scales (never a hardcoded
  ceiling). Every chart needs a table twin — the values must be readable without color (the analysis canvas's
  raw-data table is one click away on any mark). A chart with genuinely different semantics (the trend page's
  baseline threshold + status dots) may stay bespoke, but still takes its series color from `palette.ts`.
- **The analysis canvas is conversation-driven, not picker-driven** (`features/analyze-scorecards`,
  `/{ws}/scorecards/analyze`): it lands BLANK and the agent's `apply_view_config` draws the lens. Do not
  re-introduce stat tiles, a preset row, a search box, filter combos or a group/measure/viz strip — creating an
  analysis is starting a conversation, so the entry opens the chat on a fresh one and the canvas carries only the
  `describeConfig` chips, one save control, the chart/table, and a click-to-drill raw table. Same shape on a saved
  View's page. See `docs/architecture/analysis-studio.md` (C delta 2026-07-31).
- **Settings UIs** = Linear settings-list (`shared/ui/settings-list.tsx`, label-left / compact-control-right
  divided rows), not stacked full-width forms. **Settings content width is ONE shared column**: every settings
  tab — form/account (General · Profile · Preferences · API keys · Personal secrets) AND data-dense (Members ·
  Secrets · Models · Integrations · Observability · CI · Runners · Budget) — renders inside the single
  `app/[workspace]/settings/layout.tsx` wrapper (centered `max-w-5xl`), so the content's left/right edges never
  shift between tabs. A page just starts with its own `<div className="space-y-6">` (no per-page width class,
  no inline `max-w-*` — the layout owns width). The former two-tier `SettingsColumn` split was removed.
- **Guide/help copy is never inline** — render an info icon via `shared/ui/tooltip.tsx` (`InfoTip`), reveal
  on hover. Field-level `<p>` hints under inputs are fine; panel/list guidance is not.
- **Detail views**: hide empty sections entirely (no "none" placeholder); entities show a meta strip, not a
  bare `dl` grid. **An entity detail is a ROUTED PAGE, never a dialog** — the right infra panel is half the
  workflow (edit/experiment on what the left half shows), and a modal makes that split impossible.
  **Settings › Agent › Skills lists only what the workspace OWNS** — no "built-in"/"shared" tier: an Everdict or
  third-party skill in the store is an EXAMPLE, and taking it (`POST /skills/import`) copies it into the library as
  an ordinary workspace skill, editable and versionable from `settings/skills/[id]` like anything a member wrote
  (`origin` on the record is provenance only). Never re-introduce a read-only skill row that the agent follows but
  nobody can edit. The detail's primary edit path stays "대화로 편집하기" (mission `skillEdit`), paired with
  **"새 버전 찍기"** — the row is the working copy and a stamp freezes it (`skill.version` vs the newest stamp's
  `stampedAt` is what renders the "edited since" badge; a stamp deliberately does not touch `updatedAt`).
  **A settings LIST whose rows are entities links each row to that detail** — the row's name is the drill-in (the
  right side belongs to its switch). `settings/tools/[key]` is the reference: a routed detail that EXPLAINS the thing
  (transport · the functions it puts in front of the model, under the bridged name · the description the model reads
  verbatim · the pinned source) and lets the member act on it (bind its secret via `SecretPicker`, connect-test or
  run it, edit it in chat). A tool key carries `:`/`/`, so encode it into the segment on both sides.
- **Domain-specific chat entries carry a MISSION**: a specialized entry like a skill detail's "대화로 편집하기"
  passes `mission` to `MentionInChatButton`/`AskAgentButton`/`AgentChatOpener` → `PendingMention.mission` →
  `AgentChatPanel`. The chat surface is UNCHANGED; only the empty-state icon/title/body/suggestions swap to that
  task's catalog block (`agentChat.missions.<kind>`, vocabulary in `entities/agent-session`), and the empty state
  names the target from the reference chip that arrived with it. Every mission has an INTENT
  (`AGENT_CHAT_MISSION_INTENTS`): `edit` (skill/tool/harness/dataset/judge/runtime/environment/agentCraft) lands on
  a FRESH DRAFT when a persisted conversation is open and defaults the button caption to "대화로 편집하기";
  `analyze`/`ask` (view/scorecard/run · knowledge) keep the open thread — comparing two scorecards in one
  conversation must survive the entry — and only frame the chat when it is empty. An entry that CREATES the thing
  it talks about (the blank analysis canvas) passes `fresh` alongside its analyze-intent mission to get the
  edit-intent behavior for that one entry, instead of bending the mission's intent. Mission state clears on
  new-conversation / session switch. A new mission = one enum value + one intent entry + one catalog block in BOTH
  locales + the prop at the entry — never a second chat component. Every detail-page chat entry passes its mission;
  only truly generic surfaces (the @-picker, the trace browser's chip-adder) stay mission-less with default copy.
- **State toggles** = a status icon + click dropdown (`shared/ui/dropdown-menu.tsx`; e.g.
  `widgets/notification-bell/`), not text links.
- **Infra split view** (`widgets/infra-panel`): infra concerns (schedules · runtimes · runs · work queue · a
  selected workspace file) open
  in the floating right panel toggled by the vertical rail — eval pages stay on the left half, and the sidebar
  is eval-only (don't re-add runs/schedules/runtimes nav entries; the palette's infra group opens the panel
  via `openTab`). **The page tabs host the REAL routed pages in same-origin iframes** (user decision — never
  re-implement infra pages as panel summaries, and no "full page" links): the [workspace] layout detects the
  iframe (sec-fetch-dest / `?embed=1`→`x-everdict-embed`) and hands `ShellSwitch` an embed hint whose framed
  state is STICKY (the dynamic layout re-renders on soft nav without the signals — don't move the decision
  back to the server). `EmbedShell` renders pages chrome-less and escapes eval-axis links to the parent
  (`everdict:left-nav` → left router); infra links stay in-iframe. Deep entries = `useInfraPanel().openRun/
  openRuntime/openSchedule` (iframe `src` is frozen at first mount — deep-opens go through
  `contentWindow.location`, never the src prop, or React would undo the user's in-iframe navigation).
  The **files** tab is purpose-built like work/agent (no iframe, no rail button): Settings › Files calls
  `useInfraPanel().openFile(path)` → the panel renders `FileViewer` (features/browse-files) interactively;
  panel-side mutations bump `fsRevision` so the selecting tree refetches in place. The **knowledge** tab follows the
  same shape for the graph map: Settings › Knowledge publishes its graph (`publishKnowledgeGraph`) and picks nodes
  (`openKnowledgeNode`), and the tab renders the picked node's detail FROM THAT PUBLISHED DATA — never a re-fetch of
  the neighbourhood, so the map and the detail cannot disagree; picking a neighbour in the panel writes the selection
  back, which re-centres the map. A feature must not reach up into the panel: like `SettingsFilesExplorer`, the
  page-level `SettingsKnowledgeMap` owns `useInfraPanelOptional()` and passes `selectedId`/`onSelect` down.
  Entry actions belong to `FileTreePane`, never to `FileViewer` (which only reads/edits the open document — no
  Move, no Delete): the tree owns the folder context and the multi-select. Moving is drag-and-drop (dragging a
  checked row carries the whole selection) plus a "Move to…" folder picker for destinations a drag can't reach;
  deleting is a hover-revealed row trash and a bulk action. Multi-select reuses the scorecard-list grammar
  (hover-revealed checkbox, shift-click range, click-toggles-instead-of-opening while selecting, Esc clears,
  portaled action bar measured against the enclosing `<main>`) — it is NOT persisted, because a path is not a
  stable id. Hosts re-point (`onMoved` → `rewriteMovedPath`) or close (`onRemoved` → `coversPath`) their viewer.
  Panel lifecycle: iframes persist across TAB SWITCHES only — CLOSING the panel discards them (user decision:
  reopen = fresh per-tab render, and the recovery gesture for stuck frames). The header back button walks a
  parent-tracked per-tab stack fed by `everdict:frame-nav` reports — never `history.back()` (joint session
  history would undo LEFT-side navigation). Theme: the parent is the single authority — framed docs adopt its
  `html.dark` at load (layout inline script) and `EmbedShell` mirrors it live via MutationObserver; never give
  a framed page its own theme computation. Auth: a dead session must never render sign-in inside the panel —
  middleware 401-escapes embed requests, and the [workspace] layout renders `FrameEscape` (top-window escape)
  for the principal-null case the middleware can't see.
- **Rendering a workspace file** is `features/browse-files/ui/document-preview.tsx` — ONE switch over
  `previewKindFor(path, contentType, encoding)` covering prose · CSV grid · code · image · pdf · media · office
  document · archive · binary, with `FileViewer` owning only the chrome (raw toggle, download, edit, history).
  A new format is a row in the contracts type table (`FS_CONTENT_TYPES`, the SSOT) plus a branch here — the web
  MIRRORS the class tables in `lib/file-kind.ts` because runtime-decoupling forbids importing contracts values,
  so keep the two in step. `CodeEditor` takes a wide `CodeLanguage`: a new language is a lazy
  `@codemirror/legacy-modes` entry, never a second editor, and unknown paths render as `'plain'` rather than
  guessing. Anything the browser can't show still downloads (`lib/file-bytes.ts`, client-side blob). **Run**
  appears for runnable extensions ONLY when `GET /me` reports `config.fileExecution` (the deployment composed an
  execution driver) AND the member may write — never a button whose only possible answer is 404; the result
  renders in `ui/execution-output.tsx` like a terminal (a non-zero exit is a result, not an error toast).
- **Secret-name inputs** are never free text — use `SecretPicker` from `features/pick-secret`
  (combobox over preloaded names + "new" inline create; `defaultMultiline` for PEM/kubeconfig).
  Used by harness env, GHE App private key, Mattermost tokens.
- **Judge multi-select** = `JudgePicker` from `entities/judge` (add-combobox + one row per selected judge
  with its own version combobox via `versionOptions`) — never re-implement the chip picker or hardcode
  `version: 'latest'`. Used by the scorecard wizard (both modes), schedule form, re-run dialog.
- **Create/edit form width**: the page's `Card` owns the width cap (`max-w-2xl`, `max-w-3xl` for the judge
  code editor and the harness wizard) and the form fills it — never cap the form inside a full-width Card
  (fields would hug the left edge on wide screens). **Field grids are container-queried, never viewport-queried**:
  mark the form root `@container` and write `grid gap-3 @md:grid-cols-2 @2xl:grid-cols-3` (combobox/long-label
  triples) or `@sm:grid-cols-2` (short pairs) — a `sm:`/`lg:` breakpoint measures the wrong axis, because the
  same form renders full-width (new-version page), inside a capped Card, and in the ~500px column left when the
  infra panel is open. A subform shared by several wizards (`entities/trace-source` `TraceSourceFields`) declares
  its OWN `@container` so it is correct in any host. Flex rows that pair an input with a button/toggle give the
  input `min-w-0 flex-1` (else it collapses to ~30px) and stack with `flex-col … @sm:flex-row`. Reference:
  `features/register-harness/ui/register-harness-wizard.tsx`. The same container-over-viewport rule already
  governs detail views (`app/[workspace]/harnesses/[id]/page.tsx`, `features/inspect-harness/ui/*-view.tsx`) —
  Tailwind container breakpoints are NOT the viewport rem values (`@sm`=24rem, `@md`=28rem, `@2xl`=42rem).

## Language & i18n (per CLAUDE.md)
Skill/rule bodies English; **code comments Korean**. User-facing UI copy is **never hardcoded** —
it lives in next-intl catalogs `messages/{ko,en}.json` (add every new string to BOTH in the same PR).
Locale is **cookie-based** (`shared/i18n/`: cookie > Accept-Language > `en`) — NO `/[locale]` URL
segment (the first path segment stays the workspace). Client components use `useTranslations()`,
server components `getTranslations()` (`next-intl/server`); the switcher is `features/switch-locale`
(sidebar footer). Static module configs (e.g. `nav-config.ts`) store message **keys** (`labelKey`),
resolved with `t()` at render. Reference migration: `widgets/app-shell`.

See `docs/web.md` (screens + run) + `docs/auth.md` + `docs/tenancy.md`; the rule `web.md` has the inlined
critical rules.
