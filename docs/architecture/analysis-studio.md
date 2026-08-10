# Analysis Studio — natural-language analysis, artifacts, and scheduled reports over Views

> **Status: V1–V5 LANDED + LIVE-VERIFIED (2026-07-28).** The full report loop ran against the dev stack
> with a real model: schedule fire → headless agent turn (37s — get_view → query_scorecards over 79 real
> scorecards → write_report) → artifact auto-pinned to the View → gallery route + `report_completed`
> notification, all end-to-end. The live run also caught (and fixed, with a regression test) a wire-shape
> drift in the report-runner adapter (`tenant` vs `workspace`). **2026-07-28: `html` artifact kind added**
> (maintainer feedback — numeric dashboards over prose): `render_html` emission tool + sandboxed-iframe
> `HtmlView` (principle 2, revised) + the report prompt reworked dashboard-first (metric cards with
> baseline/delta REQUIRED, markdown demoted to a brief companion; the report turn now pins every artifact
> it produced, primary = the html dashboard). Remaining: view-linked sessions
> (deliberately descoped — the `@view` mention covers context injection) and the deploy env pair
> (`AGENT_SERVICE_URL` + `AGENT_INTERNAL_TOKEN` on the control plane, `AGENT_INTERNAL_TOKEN` on the agent
> service) which enables report firing. Originally a doc-first SSOT; successor/extension of
> [scorecard-analysis-views.md](./scorecard-analysis-views.md) (the pivot engine + saved Views) composed
> with [agent-conversations.md](./agent-conversations.md) (the conversational agent runtime) and
> [agent-teams.md](./agent-teams.md) (proactive/scheduled agent turns).
>
> **Vision (maintainer, verbatim intent):** data scientists increasingly drive analysis through an agent
> directly — Everdict's analysis Views should work the same way. (1) Every analysis view supports
> **natural-language data analysis AND visualization**; (2) the results are delivered **onto the view as
> artifacts** (Claude-Artifacts-style durable outputs, not ephemeral chat text); (3) **periodic reporting**
> is supported the same way, so the analysis reaches the team without anyone asking for it.

## Where we are (the seeds this composes from)

Nothing here is a rewrite — every pillar exists and this feature is their composition:

- **The pivot engine** (`apps/web/src/features/analyze-scorecards/model/analysis.ts` — `AnalysisConfig` →
  `computeAnalysis` → grid/line): four lenses (leaderboard/by-harness/trend/compare) as configurations of
  one model; Views persist the config (`everdict_views`, opaque jsonb) and re-run live on open. Deferred
  S4 (server-side pivot) becomes load-bearing here.
- **The agent runtime** (`packages/agent-runtime` + `apps/agent`): loop with `onEvent` SSE, `permit` HITL,
  `drainInput` steering; MCP read tools over the control plane (`list_scorecards`, `diff_scorecards`,
  `leaderboard_scorecards`, `inspect_trace`, …); **first-party code tools** (`web_search`/`pdf_read` in
  `packages/application-control/src/capability/first-party.ts`) — the exact pattern an analysis tool family
  reuses; per-workspace `AgentSpec` (instructions/model/disabledDefaults).
- **Headless agent turns** (`agent-teams.md` S3–S5): `runTeammateTurn` runs an authenticated request-less
  turn; `issueAgentToken` mints an `agt_` token acting AS a creator; `/agent/events` has an internal-token
  path. A scheduled report is exactly "a message wakes an agent" — the primitive is live.
- **Artifact offload** (`ArtifactStore.put(key, data, contentType)` → fetchable ref;
  `offloadAnalysis` → `ScorecardRecord.analysisRef`, mig 0075): per-scorecard analysis bundles
  (summary + per-case verdicts/scores) are already durable, downloadable JSON.
- **Schedules + delivery** (`ScheduleRunTemplate` batch|pull modes, Temporal driver, `POST …/fire`;
  `NotificationService` fan-out: personal feed + Mattermost `post()` with attachments + `AgentEventSink`).

The gap is precisely: (a) the agent has **no artifact-emission path** (`ToolResult` = text + images only),
(b) there is **no sanctioned analysis compute** for it (only canned read tools; no server-side pivot), and
(c) schedules can fire **only scorecards**, not an agent task.

## Principles

1. **NL and direct manipulation converge on one model.** "Show pass-rate trend by harness for July" is an
   `AnalysisConfig` mutation — the agent drives the SAME pivot engine the pickers drive (`apply_view_config`
   tool → live canvas update). The user can always take over by hand; the agent never renders a chart the UI
   couldn't have produced itself. Free-form analysis beyond the pivot goes through artifacts (below), not a
   parallel rendering path. *(2026-07-31: the pickers themselves are gone — see the C delta. The invariant that
   survives is the ENGINE one: the agent may only produce a config the pivot engine can draw, so nothing on the
   canvas is outside the platform's own vocabulary.)*
2. **LLM output never executes in the APP origin.** *(Revised 2026-07-28 — maintainer feedback: numeric,
   metric-by-metric visualization with baseline/delta comparison is the product core, and a closed spec is
   too rigid for it.)* Two artifact tiers now coexist: **declarative** kinds (ChartSpec/table/markdown —
   rendered by our own components, the lightweight path) and **free-form `html`** (the Claude-Artifacts
   model — the agent authors body markup with inline style/script/SVG for rich dashboards: metric cards,
   ▲/▼ delta chips, custom layouts). The safety invariant is containment, not prohibition: html artifacts
   execute ONLY inside an opaque-origin sandboxed iframe (`sandbox="allow-scripts"`, no
   `allow-same-origin` — no parent DOM/cookies) under a shell-injected deny-all CSP (`default-src 'none'`;
   inline style/script only; `img-src data:` — no network load OR exfiltration). Nothing an LLM emits ever
   runs in the app origin.
3. **Compute is dispatched, never on the control plane.** Aggregation the platform already understands runs
   as a server-side query (`query_scorecards`). Arbitrary data-science code (the real "data scientist with
   an agent" power) runs SANDBOXED through the existing job-runner dispatch — the code-judge invariant
   (`runCodeJudge` precedent), HITL-gated, isolated-runtime-only.
4. **A View becomes a container, artifacts inherit its visibility.** View = lens config + its conversations
   + pinned artifacts + its report schedule. `private|workspace` continues to gate everything attached;
   authz keeps reusing `scorecards:read`/`scorecards:run` (no new actions — the Views precedent).
5. **Reports are schedules; the agent is the runner.** Periodic reporting adds a third
   `ScheduleRunTemplate` kind — one scheduling engine (cron/timezone/overlap/enable/fire-now/history), one
   provenance model (`origin.scheduleId`), one delivery fan-out (feed + Mattermost + agent events).
6. **Cost is the tenant's, bounded.** Analysis turns use the workspace model↔secret binding (D3 of
   agent-conversations); scheduled turns run under the schedule creator's identity with a turn budget —
   a runaway report can never spend unbounded tokens.

## Architecture

```
             ┌──────────────────────── /views/[id] — Analysis Studio ────────────────────────┐
             │  canvas (pivot board, live)      chat (agent, SSE)       artifact rail        │
             │        ▲   apply_view_config ◀──── agent turn ────▶ emit artifact ─▶ pinned   │
             └────────┼──────────────────────────────┼───────────────────────▲───────────────┘
                      │                              │                       │
   web pickers ───────┘        apps/agent ◀──MCP──▶ apps/api           AnalysisArtifactStore
                                    │                 │ query_scorecards      (DB row + ArtifactStore blob)
                                    │                 │ get_scorecard_analysis
                              run_analysis ──dispatch──▶ job-runner (sandboxed script)
                                    ▲
   Schedule {report} ── fire ──▶ headless agent turn ──▶ report artifact ──▶ feed · Mattermost · agent events
```

### A. Server-side analysis query (the deferred S4, now load-bearing)

`POST /scorecards/query` + MCP `query_scorecards`: execute an `AnalysisConfig` server-side →
`GridResult | LineResult` JSON. The pure pivot moves/is mirrored from
`apps/web/src/features/analyze-scorecards/model/analysis.ts` into `@everdict/domain` (pure fns over the light `ScorecardRecord`
shape, next to `summarizeScorecard`/`trendSeries` — no I/O), so web (large workspaces) and agent share one
engine. Companion `get_scorecard_analysis(id)` returns the offloaded `AnalysisBundle` (per-case
verdicts/scores via `analysisRef`) for case-level deep dives without re-reading every run. Both are read
verbs → no HITL. This slice is valuable standalone (big-workspace dashboard perf) before any agent work.

### B. Artifact substrate (the one genuinely new primitive)

- **`ToolResult.artifact?`** (`packages/agent-runtime/src/tools/definition.ts`): a tool may return
  `{kind: 'chart'|'table'|'report'|'file', title, spec?|ref?, contentType?}` alongside `content` (the
  text the model sees stays a compact summary — the artifact is for humans).
- **`AnalysisArtifactRecord`** (`@everdict/contracts` + `@everdict/db` store + migration at the next free
  number): `{id, tenant, kind, title, sessionId, messageId?, viewId?, pinned, spec? (jsonb, size-capped),
  blobKey?, contentType?, createdBy, createdAt}`. Small declarative payloads (ChartSpec/table/markdown)
  live inline in `spec`; large payloads (CSV/JSON exports, images) go to `ArtifactStore` under
  `agent-artifacts/<tenant>/<id>` with the **key** stored and the URL **minted at read time** (a `getUrl(key)`
  on the `ArtifactStore` port — presigned URLs expire, so a persisted `put()` ref is never a durable handle:
  even `analysisRef` is only a marker that the artifact EXISTS, and the read side goes through
  `ArtifactStore.get(key)`, never by replaying that URL).
- **Emission tools** (first-party, in `first-party.ts` style but host-native — no network hop needed):
  `render_chart {spec}` (validated ChartSpec → chart artifact), `write_report {title, markdown}`,
  `export_table {title, rows}`. The agent host (`apps/agent`) persists the record, links it to the
  session/message, and streams an `artifact` SSE event.
- **ChartSpec** (closed, zod-validated, in contracts): **shipped as `{type: 'line'|'bar', x, series:
  [{label, points}], yUnit?}`** with point/series caps — `area`/`scatter`/`dist` were never built and are
  not a commitment (add one only when a caller needs it). Rendered by the
  `apps/web/src/shared/ui/charts/*` family, which is also what the pivot canvas and the billing dashboard
  draw with, so an agent-emitted chart and a hand-built one are the same object visually. The contract
  allows more series than the palette has slots: the renderer plots `MAX_SERIES` and discloses the rest
  rather than generating hues.
- **View attachment**: `pin_artifact` (host tool + `POST /views/:id/artifacts/:artifactId/pin` + web pin
  button) attaches an artifact to a view; the view page shows the pinned gallery. Unpinned artifacts
  remain browsable in their conversation.

### C. Studio surface (web redesign)

`/views/[id]` becomes the **Analysis Studio**: the pivot canvas (existing `CustomAnalyzer`, live) + an
embedded agent conversation (reusing `features/agent-chat` components — transcript, composer, SSE,
HITL dialogs) + the artifact rail (pinned gallery; click → preview dialog with download).
*(Delta 2026-07-28, maintainer decision: the conversation is NOT embedded in the page — the studio
extends the existing RIGHT panel (`widgets/infra-panel` agent tab), keeping the left/right split:
left = routed content canvas, right = the one persistent agent conversation. Landed as the studio
entry: "New analysis" (`/views`) → `/scorecards/analyze?mode=custom&chat=1` — the canvas on the left
with the chat revealed on the right via `AgentChatOpener` (askAgent draft prefilled, nothing
auto-sends), plus a persistent "Analyze with agent" header button on the analyze page,
view-referenced when a saved View is linked. The reverse direction also landed: right before each
send the chat panel captures the canvas's LIVE state over a synchronous same-window round-trip
(`everdict:canvas-state-request` → `everdict:canvas-state`, `configToStored(config)` + the open View
id), the chat body carries it as `canvas {config, viewId?}`, and `runChat` folds it into the model's
user turn with the delta-editing rule — so multi-turn refinement ("make it a bar chart", "regroup by
model") grounds on what the member actually sees, manual picker changes included. The channel also
carries presence: the canvas announces unprompted on mount/change and clears on unmount, and the
composer shows a "canvas linked · name" chip — the member SEES that the agent shares their screen.
The preamble additionally steers saving (update_view for an open saved View / create_view otherwise,
both taking the in-context stored-form config), and the panel soft-refreshes the left routed page
after each turn so agent-created entities appear without a manual reload. Finally, the pre-studio
wizard is REMOVED (maintainer decision): the easy 3-question mode (`ScorecardAnalyzer`) and the
easy/custom toggle are gone — `/scorecards/analyze` is the one studio canvas, NL chat + pickers over
a single AnalysisConfig.)*
*(Delta 2026-07-31, maintainer decision — **the canvas is conversation-only**: the pickers went the way
of the wizard. The stat tiles, presets, search box, filter bar and group/pivot/measure/sort/viz strip are
REMOVED, and the raw-data table now appears only as a drill-down under a clicked mark. `/scorecards/analyze`
lands BLANK — creating an analysis is starting a conversation, so the entry opens the chat on a NEW
conversation (`fresh` on the pending mention, the analyze/ask-intent counterpart of an edit mission's fresh
draft) and `apply_view_config` is the only thing that draws the first lens. A blank canvas still announces
itself on the `everdict:canvas-state` channel with an EMPTY config, and `buildCanvasPreamble` says so in
words, so the turn knows nothing is on screen and that the surface has no pickers to fall back on. What
survives on the canvas: `describeConfig` chips (the lens, readable back), one save control (create a View /
update the open one — listing, sharing and deleting stay on `/views`), the chart or table, and the
drill-down. Principle 1 still holds for the ENGINE — one `AnalysisConfig`, one `computeAnalysis` — but the
direct-manipulation half of the surface is retired; the member steers by talking.)* New FSD slices:
`entities/analysis-artifact`, `features/analysis-studio`; `features/agent-chat` gains artifact rendering in
the transcript (chart/table/markdown cards) and an embed mode. Sessions opened from a view carry
`viewId` (new nullable column on `everdict_agent_sessions`), and the turn's context preamble injects the
view's current config + the workspace's metric vocabulary, so "이번 뷰 기준으로" questions ground correctly.
The agent's `apply_view_config {config}` is a host-routed tool (like todo/plan — no MCP hop): it validates
against the AnalysisConfig schema, emits a `view_config` SSE event, and the canvas applies it live; the
user's manual picker changes flow back into the next turn's context. `/views` list cards gain artifact
thumbnails + last-report time. Full i18n (en/ko) as usual.

### D. Sandboxed analysis scripts (the data-scientist escape hatch)

`run_analysis {language: 'node'|'python', code, input}`: dispatched through the existing job-runner
script contract (the code-judge mechanism — no-op harness + script over a context file), input = the
result of prior queries (grid JSON / analysis bundles), stdout JSON → optionally folded into an artifact.
Guardrails: HITL-gated every call (`isReadOnly:false`), **isolated-runtime-only** (the same
`runtime.isolated` trust gate `buildCodeTools` applies to adopted code — skipped on non-isolated dev),
timeboxed, no ambient secrets beyond the sanctioned model env. This is deliberately a later slice: A+B
cover the 80% (pivot + charts + reports) with zero new attack surface.

### E. Scheduled reports

- **Template kind 3** (`packages/contracts/src/records/schedule.ts` union):
  `{report: {view: string, instructions?: string, compare?: 'previous-period'}}` — mutually exclusive
  with batch/pull, same cron/timezone/overlap/enabled envelope.
- **Fire path**: `ScheduleService.fire()` branches on the template — report kind invokes an
  `AgentReportRunner` port (HTTP client to a new internal `apps/agent` route, `x-internal-token` like
  `/agent/events`), passing `{workspace, createdBy, viewId, instructions, scheduleId}`. The agent server
  mints the creator-scoped token (`issueAgentToken` precedent), creates/reuses a view-linked session, and
  runs a **headless turn** (the `runTeammateTurn` primitive) seeded with: the view's config, the period
  window, `compare` → `diff_scorecards`/`query_scorecards` against the previous window, and the standing
  instructions. The turn must end by emitting ONE `report` artifact (+ optional charts), auto-pinned to
  the view's report archive.
- **Stamping + delivery**: the schedule records `lastStatus`/`lastArtifactId` (mirroring
  `lastScorecardId`); `NotificationService` gains `notifyReport(record)` → personal feed + Mattermost
  (summary snippet + deep link `/views/<id>?artifact=<aid>`; Mattermost `attachments` already supported)
  + agent event kind `report.completed` (a proactive teammate can react — e.g., escalate a regression).
  Delivery failure never fails the report (the notification invariant).
- **Turn budget**: headless turns run with a hard `max_turns`/token budget and no write control-plane
  tools (read + emission tools only — `AGENT_ALLOW_EVAL_DRIVE` is irrelevant here); a failed/overrun turn
  stamps `lastStatus` with the reason (the schedule auto-disable precedent for config errors).

## Roadmap (staged; each slice shippable + gated green on its own)

- **V1 — server-side analysis query. ✅ LANDED.** The pivot engine's server-side twin lives in
  `@everdict/domain` (`packages/domain/src/scorecard/analysis.ts` — `computeAnalysis` over the structural
  `AnalysisCard` list shape, lockstep-mirrored with the web engine incl. the group-key separator);
  `POST /scorecards/query` (strict-enum body DTO → 400 on a bad value) + `GET /scorecards/:id/analysis`
  (server-side `analysisRef` fetch, http-only gate, `UpstreamError` remap) + MCP `query_scorecards` /
  `get_scorecard_analysis`; wire response schemas in `@everdict/contracts/wire` (`scorecard-analysis.ts`).
  The web dashboard still computes client-side (switching it to the route above a workspace-size threshold
  moved to V3, where the Studio consumes the same route). Covered by domain fixture tests + service tests
  (narrowing, bundle fetch/404/502) + route/MCP tests.
- **V2 — artifact substrate. ✅ LANDED (backend; web rendering moved to V3).** Contracts
  `records/analysis-artifact.ts` (`AnalysisArtifactRecordSchema` — spec opaque-jsonb like View.config,
  validated per kind at the emission boundary via `parseAnalysisArtifactSpec`; `ChartSpecSchema`
  line|bar with series/point caps + `TableSpecSchema` + `ReportSpecSchema`); `AnalysisArtifactStore`
  port (application-control) + InMemory/Pg stores (`@everdict/db` activity/, mig 0077); apps/agent
  emission tools (`artifact-tools.ts`: `render_chart`/`render_table`/`write_report` — native, per-turn,
  `isReadOnly:true` per the write_todos precedent since they only write conversation-scoped presentation
  state) wired in `runChat` when `ChatDeps.artifacts` is present (registry extended per turn); SSE
  `artifact` event + `GET /agent/sessions/:id/artifacts` (owner-scoped, createdAt asc). Design deltas vs
  the original sketch: no `ToolResult.artifact` kernel change (host tools persist + notify directly — the
  kernel stays domain-agnostic) and no `ArtifactStore.getUrl`/file kind yet (blob payloads have no caller
  until `run_analysis` V5; charts/tables/reports are inline declarative specs). Transcript/gallery
  rendering lands with V3 (the agent-chat UI was under concurrent rework).
- **V3 — the Studio. ◐ FIRST CUT LANDED (gallery + report_completed surfaces).** Landed:
  `AnalysisArtifactStore.listByView` + `GET /agent/views/:viewId/artifacts` (visibility double-gate — the
  agent forwards the caller's bearer to the control-plane views read via `viewAccessChecker`, so the
  private|workspace rule stays single-sourced); web `entities/analysis-artifact` (drift-guarded mirrors) +
  `features/analysis-artifacts` (`ArtifactCard` — hand-rolled SVG line/bar ChartView + TableView +
  markdown ReportView, per-kind spec validation with graceful fallback; `ViewArtifactGallery` as a server
  component over `agentPlane.listViewArtifacts`) rendered on `/views/[id]`; `report_completed` bell
  kind + `link.artifactId` mirrored (the drift guard caught it, as designed); `analysisArtifacts` i18n
  namespace (en/ko). **Second cut:** the view-page **Report schedules section**
  (`features/view-report-schedule` — lists this view's report-mode schedules in place with run-now/
  pause/delete row actions, and a member-gated create dialog with cadence presets [weekly/daily/monthly/
  custom cron], standing instructions, and the previous-period compare toggle; server actions over the
  existing schedule surface — one scheduling engine, surfaced where the report lives). The web schedule
  mirror gained `runTemplate.report` + `lastArtifactId` (optional-field additions slip past a structural
  drift guard, so mirror them deliberately). **Third cut:** artifact cards render IN the agent-chat
  transcript — `buildTranscript(messages, artifacts)` interleaves each artifact after the last message at
  or before its creation (closing an open activity card like assistant text would), hydrated via
  `GET /api/agent/sessions/:id/artifacts` on session open and appended live from the SSE `artifact`
  event; `ArtifactCard` became a client component shared by the transcript and the view gallery.
  **Fourth cut:** `apply_view_config` — a host tool (`apps/agent/src/view-config-tool.ts`, registered only
  when the SSE handler wires `ChatHooks.onViewConfig`, so headless turns never carry it) whose input IS the
  saved-View stored-form vocabulary (get_view output can be tweaked and re-applied verbatim); the SSE
  `view_config` event broadcasts same-window (`everdict:view-config` CustomEvent) and `CustomAnalyzer`
  applies it via `storedToConfig` (defensive normalize) — the agent drives the same canvas the pickers
  drive, the member keeps manual control. **Fifth cut:** pin/unpin + list rollups — `POST/DELETE
  /agent/artifacts/:id/pin` (creator-only; the target View re-verified via checkViewAccess) +
  `AnalysisArtifactStore.detachFromView`/`summarizeByView`; the web `PinControl` (lazy view picker over a
  new `/api/views` BFF) rides the `ArtifactCard` action slot in both the transcript and the gallery
  (client-safe feature barrel split from a `server.ts` entry — the gallery is server-only);
  `GET /agent/views/artifacts-summary?ids=` (answers ONLY the ids the caller already holds — no private
  view-id disclosure) powers the `/views` card chip (artifact count + last report time). **Remaining for
  full V3:** view-linked sessions (`viewId` on AgentSession + the view-context preamble — today the
  `@view` mention covers context injection).
- **V4 — scheduled reports. ✅ LANDED (backend; web form → V3 batch).** Third `ScheduleRunTemplate` kind
  `{report: {view, instructions?, compare?: "previous-period"}}` (exactly-one-mode refine, DTO + MCP
  `create_schedule report_view/…` parity); `ScheduleService.fire` report branch → the `AgentReportRunner`
  port, stamping `lastArtifactId` + `lastStatus: reported|report-empty` (mig 0078) with the same
  config-failure auto-disable / transient-rethrow discipline; the apps/api adapter (composition/schedule)
  posts to the agent service's `POST /internal/report` (x-internal-token, the agent-event-sink env pair)
  and fans out `notifyReport` (feed kind `report_completed` linking `{resourceType: view, artifactId}` +
  Mattermost + agent event `report.completed`) best-effort. The agent side (`apps/agent/src/report-turn.ts`)
  runs ONE budgeted headless turn (16-turn cap) as the creator via a minted read-scoped one-shot `agt_`
  token (revoked in a finally): the prompt walks get_view → query_scorecards (+ the shifted previous
  window when `compare`) → `write_report`; the newest report artifact is then attached + pinned to the
  View (`AnalysisArtifactStore.attachToView`). `scheduledScorecardWorkflow` ends without polling when the
  fire returns no scorecardId (a report completes inside the fire activity).
- **V5 — sandboxed `run_analysis`. ✅ LANDED.** `apps/agent/src/analysis-script-tool.ts` — the model
  writes a short python|node script and it executes through the SAME code-tool contract (provision →
  input file → interpreter → stdout), reusing `buildCodeTool` verbatim with the model's code as the
  one-call source. Two hard gates: the builder returns NO tool on a non-isolated runtime (the
  adopted-code precedent — model-authored code never runs on the host), and `isReadOnly:false` puts
  every call behind the HITL/permission-mode gate. `env` is deliberately empty (no secrets) and the
  call is timeboxed. Registered via the chat `extraTools` seam when `ChatDeps.analysisScriptRuntime`
  is wired — delta vs the sketch: the opt-in is the operator env `AGENT_ALLOW_RUN_ANALYSIS=true`
  (default off; the `AGENT_ALLOW_EVAL_DRIVE` precedent) rather than a per-workspace toggle — promote
  it to an AgentSpec knob if workspaces need to diverge.
- **V6 — polish.** Report period-over-period diffs rendered as delta chips; regression callouts wired to
  `diff_scorecards`; artifact search/browse page; comment threads on artifacts (reuse `view` comments or
  extend resource types); MCP parity for any human-facing surface added along the way.

## Non-goals / guardrails

- ~~**No active-content artifacts.**~~ **Superseded 2026-07-28 by Principle 2** (maintainer decision):
  free-form `html` artifacts ship alongside the declarative kinds. The invariant is CONTAINMENT, not
  prohibition — LLM-emitted markup executes only in an opaque-origin sandboxed iframe under a deny-all
  CSP, never in the app origin.
- **The structured `dashboard` kind is the default; `html` is the escape hatch.** (2026-07-31.) A dashboard
  is a list of blocks — `metrics` · `chart` · `table` · `note` — each drawn by the renderer its kind already
  has, so a dashboard is a LAYOUT over the primitives, not a second rendering system. It needs no design
  gate because it has no vocabulary for a color, a size or a font: off-theme is not something to catch, it
  is something that cannot be expressed. Two semantics carry the quality and both live on OUR side: the
  agent sends `baseline` and never a delta (we subtract, round and format, so no model arithmetic and one
  rounding rule everywhere), and `higherIsBetter` decides the color — a rising cost is a regression, and
  without that flag the chip would be colored by the sign of the difference instead of by its meaning.
  Extending the dashboard means adding a block kind, never letting a block carry styling.
- **No agent-authored design.** (2026-07-31, maintainer feedback: generated dashboards were reading as a
  foreign widget pasted into the product.) An `html` artifact authors STRUCTURE and NUMBERS; the frame
  authors the look. Because the sandbox is opaque-origin it inherits no stylesheet, no `html.dark` and no
  font, so the frame **hands** it the design system: `ArtifactCard` reads the LIVE value of
  `ARTIFACT_FRAME_TOKENS` off the running theme, bakes them into `srcDoc` (re-baked on theme toggle — the
  frame cannot read the parent), and ships a class vocabulary (`.metric` / `.delta up|down|flat` /
  `.panel` / `.grid`) built from the same parts the app's own surfaces use. `HtmlSpecSchema` then
  **rejects** markup that paints outside it — hex/rgb/hsl literals, named colors, gradients, `font-family`
  and emoji — as a correctable tool error, because a literal cannot follow the member's light/dark theme.
  The color rules read only **styling regions** (`<style>`, `style=""`, paint attributes), never the
  dashboard's content: an eval dashboard legitimately prints "case #4521" or a commit "#a8d39b", and a gate
  that bounces DATA as design would order the model to recolor text it must not touch — and, in an
  unattended report turn, burn its budget doing it.
  The frame also measures its own content and reports the height up, so a model never guesses one.
  Extending the vocabulary means extending the frame's stylesheet + tokens, never relaxing the gate.
- **No color-only encoding.** Every chart has a table twin: the pivot canvas renders the raw scorecard
  rows under the aggregate (drill-down scopes them to the clicked mark), and artifact tables/reports carry
  their own values. A value must never be readable only by hue or bar length.
- **No control-plane code execution.** `run_analysis` and any code capability dispatch through the
  job-runner isolation path (code-judge invariant); non-isolated runtimes refuse.
- **No new authz surface.** Views/artifacts/reports gate on `scorecards:read`/`scorecards:run`; schedules
  keep `schedules:*`; edit/delete stays creator-or-admin. Artifacts inherit the view's visibility;
  a private view's artifacts 404 to non-owners (no existence leak).
- **No parallel scheduler.** Reports are `ScheduleRecord`s — Temporal reconciliation, overlap policy,
  fire-now, history and provenance all come for free and stay in one place.
- **Bounded autonomy.** Headless report turns: read + emission tools only, hard turn/token budget,
  tenant-attributed cost via the workspace model binding; failures stamp the schedule, never crash it.
