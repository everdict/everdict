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
4. **Pages = server components** that fetch + `.parse()` and pass plain props to `'use client'` islands.
   **A mutation must not run inside a transition, and must not `revalidatePath`.** Write it as a plain async
   IIFE with `useState` pending, and refresh through `useRefresh()` (`shared/lib/use-refresh`) — never
   `router.refresh()` directly. Three measured reasons, all on one click of an issue's project picker:
   `revalidatePath` evicts Next 16's ENTIRE client prefetch cache (+300 ms cooldown) although nothing here
   caches; every mounted `<Link>` then re-prefetches four-at-a-time (49 RSC requests); and anything after the
   `await` inside `startTransition` stays entangled with the router, so the commit lands whenever an
   UNRELATED update happens — the same click measured 26 ms to 14.8 s, tracking the poll interval. Fixed it
   is 41 ms for the control and 165–195 ms for the server-rendered half. Links go through `shared/ui/link`
   (prefetch off by default; an eslint rule blocks `next/link`). See `docs/web.md` §"A mutation must not hold
   the screen". A control that should show its new value before the page catches up keeps it in local state —
   `IssueProjectControl` is the reference.
   `revalidatePath` is gone from every action whose callers refresh or navigate (the tracker + 36 more); the
   ~24 that remain are settings-style managers with no refresh of their own, so the action response is what
   re-renders them — harmless now that nothing prefetches, and they migrate to `useRefresh()` when touched.
5. **Role-gate UI** with the `shared/auth/can.ts` mirror (`can(roles, action)`) — enforcement is still the
   control plane's (403). Hide the CTA; don't rely on it for security.
6. Web owns its LINTING (eslint/prettier, excluded from root Biome — its `lint` is a separate CI job), but its
   `build` and `test` run in the root turbo gate: a `*.test.ts` under `apps/web/src` is picked up by `pnpm test`
   with no extra wiring (vitest comes from the ROOT devDependency; the web declares none and needs no config).
   Tooling: `pnpm --filter @everdict/web {dev,build,lint,test}` (dev = port 3001). **Never run repo-wide
   formatters** in this shared WIP tree — format only files you changed.

## Reference impl
A full slice: `features/submit-run/` — `ui/submit-run-form.tsx` (`'use client'` react-hook-form island) +
`api/submit-run.ts` (`'use server'` action → `controlPlane.submitRun`; the caller refreshes) exposed via
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

**A COLLECTION is plural; ONE THING is singular** (Linear's spelling). `/{workspace}/scorecards` is the list;
`/{workspace}/scorecard/{id}` is one scorecard — a different screen, so a different word. Holds for every
resource with a detail route (issue · project · initiative · cycle · dataset · harness · judge · rubric · run ·
runtime · schedule · scorecard · skill · view · team · tool), and for a team's own cycle
(`/{workspace}/team/ENG/cycle/7`). The collection's NAMED screens keep its plural (`…/scorecards/new`,
`…/datasets/import`, `…/scorecards/analyze`) — they are that collection's screens, not one thing. `/teams` stays
plural too: it is the directory of teams. Old plural detail addresses redirect in `next.config.ts`
(`DETAIL_MOVES`, reserved names excluded by lookahead); they are 307 until the scheme is confirmed live.
An ISSUE carries its title as a trailing decorative slug — `/{workspace}/issue/ENG-12/the-judge-drops-cost-scores`
(`issueHref(workspace, identifier, title)`; the route is `issue/[id]/[[...slug]]`). Nothing reads the slug: the
identifier alone resolves, a stale slug after a rename still opens, and `/issue/ENG-12` is equally valid.

**A scope is a PATH; a filter is a query parameter.** The same rule one level down: what a TEAM owns lives under
the team's slug — `/{workspace}/team/ENG/{issues,triage,cycles,projects,scorecards,harnesses,datasets,judges}`
(`TEAM_SECTIONS`; the last four are `TEAM_EVAL_SECTIONS`, what the team evaluates WITH) — never `?team=<id>` on the
workspace-wide list. Each team holds different things (its triage inbox exists only if it turned one on, its
cycles are numbered in its own sequence), so "the same list, filtered" is the wrong description of it. Status,
priority, project and the page cursor stay query parameters, because those really are filters over whichever list
the path named. Slug = the team KEY (`ENG`), decided in `entities/team/lib/href.ts` (`teamHref` /
`teamSectionHref` / `teamSettingsHref`) — every link goes through those, never a hand-built string.
The team's SHORT address is the issue list itself (`/{workspace}/team/ENG` renders `IssueListView`, with
`…/issues` as the canonical twin) — Linear's landing, and the reason `matchTeamPath` reads a bare team path as
`issues` and the sidebar has no separate "Home" row.
`app/[workspace]/team-scope.ts` is the one entry procedure: resolve the slug (`GET /teams/:ref` takes key or id),
**redirect an id-spelled or lowercased URL to the canonical key** (same normalization the issue detail does for
`ENG-12`), and `notFound()` on a team that is absent or invisible. Legacy `?team=` URLs redirect through
`redirectLegacyTeamScope` in the same module.

**A list that has two addresses is ONE component**, not two pages: the fetch-and-render body lives in a widget
(`widgets/{issue,project,cycle,scorecard,harness,dataset,judge}-list` — `<Resource>ListView`, a server component
taking an optional `team`), and both route files are thin adapters. A team address NARROWS the read (`?team=` on the
control-plane call) and adds the scope bar; it never gates it. Harness/dataset/judge creation is NOT yet team-pinned
(no `…/new` under the team — the wizards don't carry `teamId`), so their CTA points at the workspace form from both
addresses rather than promising an owner the form cannot honour. Duplicating a list to scope it is how the two copies drift.
The rule holds when a screen EMBEDS the list too: the cycle board (`widgets/cycle-board`) draws its own header,
progress and burn-down and then renders `IssueListView` with a `cycle` scope — the widget suppresses its own
header, pins the facet and re-bases its filter links, rather than a second issue list growing under `cycles/`.

**A section's landing answers the question people came with.** `…/team/ENG/cycles` opens the iteration the team
is IN (then the next, then the most recent) — not a list of iterations, because everyone who clicks "Cycles" is
asking about this fortnight. The index gets its own address (`…/cycles/all`) and a specific one is addressed by
the number people cite (`…/cycles/7`, built by `entities/cycle/lib/cycle-view.ts` — one href builder, same rule
the team slug follows). A team-owned section that the team has switched OFF (`cyclesEnabled`, `triageEnabled`)
shows neither a sidebar row nor a scope-bar tab: an entry whose only content is "we don't use this" is worse
than no entry. The one exception is the tab for the screen you are standing on.
Gating on those screens is `canInTeam(principal, action, team?.id)` (`shared/auth/can.ts`, mirroring the domain's
`canReachTeam`): a create button on a team you are not on is a guaranteed 403, and a link into its assets is a
guaranteed 403. **Reads are NOT gated on the roster** — a workspace whose teams cannot see each other's work has
stopped being one workspace, so a team's harnesses, datasets, judges, rubrics and scorecards are the workspace's
to read. The one narrowing is a team choosing to be PRIVATE (`isPrivate`), decided server-side: a hidden row
simply never arrives, and asking for it by id answers NOT FOUND (never 403 — "you may not see this" still
confirms it exists). That is why `canInTeam` passes every `:read` action.

**Creating happens at the OWNER's address.** `…/team/ENG/scorecards/new` files the batch as that team's because
the URL says so; the workspace-level `…/scorecards/new` pins nothing and the control plane files the result
under the team that owns the harness chosen. Both are the same server component (`<ScorecardCreateView>`, an
optional `team`), and `teamNewHref` builds the link. A normalizing redirect on a create screen must pass
`create: true` to `loadTeamScope`, or fixing the slug silently drops the form.

**A picker offers exactly what the control plane accepts.** Where the team axis constrains a relation, the
options are FETCHED narrowed rather than drawn wide and filtered client-side: an issue's project picker reads
`listProjects(ctx, { team: issue.teamId })`, because an issue may only join a project its own team is on
(`docs/tracker.md`) and a wider list is a menu of guaranteed 400s. The narrowing lives in the server component
that fetches; the client island renders what it was handed and never re-filters, so there is one answer to
"what may I choose", not two that drift.

## Styling
Tailwind v4 tokens in `app/globals.css` `@theme inline` (Linear indigo `#5e6ad2`, tight `0.5rem` radius,
near-black `#08090a` dark surface). Light+dark via the `.dark` class (`@custom-variant dark`) toggled by
`shared/ui/theme-toggle` — NO `next-themes`; no-flash inline script in `app/layout.tsx`. `cn()` from
`shared/lib/utils.ts`; shadcn new-york atoms under `shared/ui/`. Dropdowns are always `shared/ui/combobox`.

## Established UI conventions (enforced — reuse, don't reinvent)
- **Every route segment has a loading boundary, and slow reads sit behind `Suspense`.** Pages are
  `force-dynamic`, so without a `loading.tsx` a navigation BLOCKS: the old screen stays frozen until the whole
  server render lands, and — the quieter half — `<Link>` prefetch does nothing at all, because Next.js prefetches
  a dynamic route only as far as its nearest loading boundary. `app/[workspace]/loading.tsx` is the default;
  a segment whose shape is distinctive overrides it (the issue list's `IssueListSkeleton`). Placeholders are
  built from `shared/ui/skeleton.tsx` (`Skeleton`/`SkeletonLines`) — sized by the CALLER, never self-sized, or
  the screen jumps when the real thing arrives. Inside a page, anything the primary content does not need
  (a toolbar's data, a side panel) goes in its OWN async component behind `<Suspense>` and streams: it must
  never join the `Promise.all` the rows are waiting on. `widgets/issue-list` is the reference — the list waits
  for its page + directories, while `IssueListActions` streams the GitHub-App state and the synced-repo roster
  in behind it. A read with two consumers (the team list: filter chips + the create dialog) is started ONCE as a
  promise and awaited only on the path that renders it, so the screen that does not draw it does not wait for it.
- **Format atoms**: score/model/version/time formatting goes through `shared/lib/format.ts` +
  `shared/ui/{score,chip}.tsx`, NEVER per-page inline.
- **Image refs** render through `shared/lib/image-ref.ts` (`displayImageRef`, with the raw ref on `title`), never
  raw: a digest is 71 characters, so a truncated line shows the digest head and eats the TAG — the only thing that
  says which version is running. Same file owns `imageRepositoryOf` (tag/digest-blind repository matching).
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
- **An agent dashboard is DATA, not markup** (`entities/analysis-artifact/ui/artifact-card.tsx`): the
  `dashboard` kind is a list of blocks (`metrics`/`chart`/`table`/`note`) each drawn by the renderer its kind
  already has — `StatCard`, `shared/ui/charts`, the table atoms, `Markdown`. Prefer it over `html`. The agent
  sends `baseline`, never a delta: `lib/metric-delta.ts` subtracts, formats (ratios in POINTS, everything else
  in relative percent, zero-baseline falls back to absolute) and colors it, and `higherIsBetter` — not the sign
  — decides good vs bad, so a rising cost reads as the regression it is. ⚠ Two traps this cost us: the metrics
  grid is **container**-queried (`@container` + `@md:`/`@2xl:`), never viewport-queried, because the same card
  renders in a narrow chat rail and a full-width gallery; and `bg-success/x` / `bg-faint/x` generate **no
  utility** (they are our own `@theme inline` colors, unlike shadcn's `destructive`/`muted`) — a chip written
  that way is silently transparent, so use `bg-[var(--color-success)]/15` as `shared/ui/badge.tsx` does.
- **The agent never authors design** (`entities/analysis-artifact/ui/artifact-card.tsx`): an `html` artifact
  supplies structure + numbers, the FRAME supplies the look. Its sandbox is opaque-origin, so it inherits no
  stylesheet, no `html.dark` and no font — `HtmlView` therefore reads the LIVE token values off the running
  theme (`FRAME_TOKENS`, mirroring `ARTIFACT_FRAME_TOKENS` in contracts; the web may not import the value),
  bakes them into `srcDoc`, re-bakes on theme toggle via a `MutationObserver` on `html`'s class, ships
  `FRAME_STYLESHEET` (the `.metric` / `.delta up|down|flat` / `.panel` / `.grid` vocabulary + our table
  treatment), and takes the frame's own `postMessage` height report instead of a model-guessed one. The
  emission schema rejects color/font literals, so agent markup CANNOT go off-theme — to give it a new visual,
  extend the stylesheet and tokens, never loosen the gate. Same rule as charts: no invented hues, ever.
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
  **A record whose title is CONTENT (the tracker's issue) takes the Linear issue-view shape instead of the meta
  strip** (`app/[workspace]/issues/[id]` is the reference): ① a breadcrumb bar — list → team → identifier —
  carrying the record-scoped actions (`CopyLinkButton`, the `⋯` menu) right after it and the prev/next SIBLING
  navigation at the far right; ② the title alone at content size (a plain `h1`, not `PageHeader` — that atom is
  for pages whose title is a NAME and truncates); ③ a container-queried two-column grid (`@3xl`) with the body
  (description · evidence · discussion) left and ④ EVERY property gathered in one right column
  (`shared/ui/property-list.tsx` — label-left/value-right, no card, empty rows omitted), placed by explicit
  `col-start`/`row-start` so it collapses ABOVE the body when the container is narrow. Reading and changing live
  in separate columns: the only control inside the property list is the one that IS a property (status). A
  property block carrying its own form (issue links) declares its own `@container` so the form folds in the
  narrow column. Siblings come from the list's own ordering, windowed (`SIBLING_WINDOW`), and the arrows stay
  rendered-but-inert at the ends so their position never shifts. **The linked-assets block lists only what
  VERIFIES the record** — `ISSUE_CAPABILITY_LINK_TYPES` (harness · dataset · judge), not the full six-type link
  vocabulary the control plane accepts: a scorecard is EVIDENCE and the evaluation-history section already owns
  it (pinned + baseline badges), so repeating it as a chip puts one thing on the screen twice with no answer to
  which is authoritative. Display and the add-form read the SAME allowlist — never offer a type that then renders
  nowhere — and the empty-section test counts the allowlisted links, not `links.length`.
  **A detail with more than one QUESTION is a tabbed route, not a longer page** (`app/[workspace]/initiatives/[id]`
  is the reference — Linear's initiative view): the `layout.tsx` owns everything that must not disappear while you
  move around (breadcrumb + record actions, the `h1`, the tab bar, the whole right property/progress column) and each
  tab is its own `page.tsx` under it, so a soft nav re-renders only the body. Two rules make it cheap and honest:
  the shared read is a module-level `cache()`d loader (`load-initiative.ts`) the layout AND each tab call — a
  fan-out detail read must not run twice per screen — and the tab addresses come from ONE href builder
  (`entities/<x>/lib/href.ts`, same rule the team slug follows), with the active tab decided by
  `useSelectedLayoutSegment()` rather than by comparing path strings. A tab renders `null` when the record failed to
  load: the layout already drew that failure, and saying it twice is worse than saying it once.
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
- **A record's history/activity is ONE feed** (`shared/ui/activity-feed.tsx` — `ActivityFeed`/`ActivityRow`/
  `ActivityActorName`), in Linear's grammar: the ACTOR'S FACE leads the row with a small event-icon badge on
  its corner (a non-member subject — the regression watch, a GitHub sync — gets the icon as the node instead;
  no connecting rail, the faces already form the column), then a short sentence ("**Dana** changed status"),
  then what changed as CHIPS, then relative time (absolute on hover). **Values never go inside the sentence**: an inlined value drags the whole
  clause through each locale's word order and Korean particles, so `{name}` leads and everything that changed
  rides after it as a badge. The atom is hook-free (locale/timeZone are props) so a server page and a client
  island render the same row. The tracker's three details (issue · project · initiative) render
  `entities/tracker-history` `TrackerHistory` — one `TrackerHistoryEvent` → icon + tone + sentence, REUSING the
  same status badges the lists use (`IssueStatusBadge`/`ProjectStatusBadge`/`InitiativeStatusBadge`) for
  `from → to`, because a status that looks different in the history than in the list reads as a different
  status. A row's `detail` bag is unvalidated wire data: read it ONLY through `lib/history-detail`
  (`detailString`/`detailStrings`/`detailNumber`/`detailFlag`) and let a missing or mistyped field drop its
  chip instead of breaking the row. Order is chronological (oldest first) with a "show earlier" head, like the
  dataset's activity — which now renders through the same atom. Actor identity comes from ONE lookup
  (`entities/member` `memberDirectoryOf` server-side / `useMemberDirectory` client-side), never a per-page
  `members.find`. A new event = one enum value + one `case` + one message in BOTH locales (`tracker.history.*`).
- **Domain-specific chat entries carry a MISSION**: a specialized entry like a skill detail's "대화로 편집하기"
  passes `mission` to `MentionInChatButton`/`AskAgentButton`/`AgentChatOpener` → `PendingMention.mission` →
  `AgentChatPanel`. The chat surface is UNCHANGED; only the empty-state icon/title/body/suggestions swap to that
  task's catalog block (`agentChat.missions.<kind>`, vocabulary in `entities/agent-session`), and the empty state
  names the target from the reference chip that arrived with it. Every mission has an INTENT
  (`AGENT_CHAT_MISSION_INTENTS`): `edit` (skill/tool/harness/dataset/judge/runtime/environment/agentCraft) lands on
  a FRESH DRAFT when a persisted conversation is open and defaults the button caption to "대화로 편집하기";
  `analyze`/`ask` (view/scorecard/run/issue · knowledge) keep the open thread — comparing two scorecards in one
  conversation must survive the entry — and only frame the chat when it is empty. **Framing only shows on an empty
  chat, so whether an entry starts fresh IS whether its framing is ever seen** — one rule decides it,
  `startsFreshConversation(entry)` in `entities/agent-session` (guarded by `mission-intent.test.ts`), never an
  inline condition at a call site. An analyze/ask entry whose subject is ONE record rather than whatever thread was
  open — the issue detail, the blank analysis canvas — passes `fresh` to get the edit-intent start for that one
  entry, instead of bending the mission's intent. `fresh` rides the same path as `mission` (button prop →
  `useMentionInChat`/`askAgent` → the framed `postMessage` → `PendingMention`). Mission state clears on
  new-conversation / session switch. A new mission = one enum value + one intent entry + one catalog block in BOTH
  locales + the prop at the entry — never a second chat component. Every detail-page chat entry passes its mission;
  only truly generic surfaces (the @-picker, the trace browser's chip-adder) stay mission-less with default copy.
  A record header that is a strip of ICONS rather than a row of buttons (the issue view's breadcrumb line) passes
  `compact` to `MentionInChatButton` — same component, same caption logic, caption folded into the tooltip — instead
  of growing a second entry component or standing an outline button in a 20px bar. **A reference is keyed by the
  name the entity is CITED by, and both entries mint the same one**: an issue's `AgentReference.id` is its
  identifier (`ENG-12`), which `get_issue` accepts exactly like the uuid — so the detail's button and the @-picker
  (`app/api/agent/mentions/[type]`, which maps the row's identifier onto `id`) produce one reference, not two chips
  for one issue. `agentChat.refType.<type>` must exist in BOTH locales for every `AGENT_REFERENCE_TYPES` entry —
  the catalog is JSON, so nothing but `entities/agent-session/model/catalog.test.ts` will notice a missing label.
- **Every chat transcript item is `memo`-wrapped** (`features/agent-chat/ui/*`, guarded by
  `transcript-render.test.tsx`): the composer's draft is state ABOVE the transcript, so a keystroke re-renders
  `ConversationView`, and a transcript item re-parses its markdown through the whole unified pipeline
  (remark-gfm → rehype-raw → sanitize) every time it renders. Unmemoized that was ~17ms per keystroke at 5 turns
  and ~46ms at 20 (node alone, before the browser's reconciliation) — the panel visibly dropped frames while
  typing. `ConversationView` therefore also `useMemo`s `buildTranscript` (it mints fresh todo/sub-agent objects
  per call, and a new identity punches straight through the memo), and an item that needs a companion control
  builds it INSIDE the memoized row (`ArtifactRow` owns its `PinControl`) rather than passing an element in. A new
  item kind is memoized and added to that test's list. Same reasoning covers any surface that renders `Markdown`
  in a list under live-changing state.
- **Reading a trace has ONE surface**: `TrajectoryView` (`features/browse-traces`) — rollup · swimlanes (one
  lane per emitter) · **`SpanWaterfall`** left / FULL payload right. Settings › Observability's sealed-trajectory
  dialog and the run detail's evidence section render the same component, so a payload read in one place is the
  payload read in the other. `SpanWaterfall` is shared with the EXTERNAL `TraceDetailDialog` (a platform's own
  trace), which is the point: the two surfaces used to look like different products because our evidence had no
  span tree to draw, not because the renderer differed. `lib/trajectory-spans.ts` projects `TraceEvent[]` →
  waterfall nodes off the contracts STRUCTURE fields; if a new emitter's events render flat, it is dropping
  `spanId`/`parentId`/`durationMs`, not hitting a view limit. It is its own `@container` (2-pane by ITS width, not the viewport's) and needs a definite
  height from the host. Never write a page-local timeline again — the run detail's was deleted for this.
  `entities/run/lib/trace.ts` (`summarizeTraceEvent`/`traceKindColor`) stays for the LIVE/compact lanes only
  (replay player, playground stream), never for settled evidence. A caller holding one stream (a legacy row
  embed) wraps it with `asSingleSegment`.
- **A run detail is a shared skeleton with ONE per-`kind` slot**, not an eval page: the ledger holds five
  executable families (`eval|agent|command|sandbox|analysis`) and the SAME columns mean different things in each
  (`harness` is the agent spec for an agent run, `caseId` is the image for a sandbox) — relabel per kind rather
  than printing "case chat". Scores are the EVAL outcome, not the universal one: the outcome slot swaps
  (eval = verdict + metric table, agent = cause + open-conversation, sandbox = the session), and a family that
  can never have scores shows no scores section at all. The pass/fail **verdict is SERVED** (`RunRecord.verdict`,
  derived by the control plane with `caseVerdict` on the same read as `usage`) — never recompute the authority
  ranking in the web (those mirrors were deleted in re-architecture P1g; one authority, one answer). Live attach
  panels (logs/exec/terminal/screen) render only for channels the run declares in `attach`.
- **A work LIST is a view with two halves: WHICH issues is the URL's, HOW they are drawn is the READER's**
  (`widgets/issue-list` + `features/browse-issues` + `entities/issue/model/{view,display}.ts` — the tracker's
  issue list is the reference). A filter decides the SET, so it serializes into the query string (`issueViewOf` /
  `issueViewHref`) and a pasted link opens the same issues for everybody. Grouping · ordering · layout ·
  "show completed" · sub-issues decide only presentation, so they are **never** in the URL: sending someone a
  link must not rearrange their screen. They live per reader in the `everdict-issue-display` COOKIE, keyed by the
  list's address (`issueViewKeyOf` — workspace list / team issues / team triage / cycle board), written by the
  `setIssueDisplay` server action and re-read on `router.refresh()`. Cookie, not localStorage, because the list is
  a server component that needs the grouping before it can ask for group counts — localStorage would make the
  chosen view a flicker. The cookie is bounded (12 views, least-recently-changed evicted) because it rides every
  request, and each field falls back independently so one renamed grouping does not discard the whole preference.
  Filters are a SET per
  facet (`?status=todo&status=in_progress`); toggling the last value off DELETES the facet rather than leaving
  `[]`, which the control plane reads as "chosen, and nothing matches". **Group headers show the SERVER's
  count** (`GET /issues/counts`), never the rows received: a grouped screen fetches one page PER GROUP, so
  counting what it holds reports the page size back to itself. Empty columns of a CLOSED vocabulary (status,
  priority) are still stood up — a board needs somewhere to drop a card — while open vocabularies (assignee,
  project, cycle) show only groups that hold issues, so a 200-member workspace does not get 200 empty columns.
  Rows carry the mutations inline (status · priority · assignee dropdowns), which is why a row is NOT a
  `<Link>`: the title zone is the link and the controls are its siblings. **Bulk editing is the same grammar as
  the scorecard list** (`features/browse-issues` `IssueSelectionProvider` + `IssueBulkBar`): hover-revealed
  checkbox, shift-click range, click-toggles-instead-of-opening while selecting, Esc clears, action bar portaled
  to `<body>` and measured against the enclosing `<main>`. Two deltas from the scorecard list, both deliberate —
  the selection is NOT persisted (the filters live in the URL, so one back navigation makes a restored
  selection unanswerable), and shift-ranges resolve against **DOM order** (`[data-issue-id]`) because groups
  append rows client-side and the server's ordering can no longer describe what is on screen. The provider is
  only mounted where an action exists (a team scope); elsewhere rows render exactly as before. Beyond a group cap the screen SAYS how
  many groups it did not stand up (`groupsTruncated`) — silent truncation reads as "that's all of them".
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
- **A download link points at OUR route, never at an object-store ref**: a record's `analysisRef`/`screenshotRef` is a
  PRESIGNED url minted on the SERVER-internal endpoint (`http://minio:9000`) — an outside browser can't resolve it and
  it expires within the hour, so a page that links it ships a dead link to everyone but the operator. Add a BFF route
  (`app/api/**/route.ts`) that asks the control plane and returns the bytes with a `content-disposition` filename;
  the scorecard detail's `/api/scorecards/[id]/analysis` is the reference. Gate the button on the record SAYING it has
  the artifact, not on the ref's scheme.
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
