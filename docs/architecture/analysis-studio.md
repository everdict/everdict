# Analysis Studio — natural-language analysis, artifacts, and scheduled reports over Views

> **Status: doc-first SSOT (2026-07-27) — planning, not started.** Successor/extension of
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

- **The pivot engine** (`apps/web/.../analyze-scorecards/model/analysis.ts` — `AnalysisConfig` →
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
   parallel rendering path.
2. **Artifacts are declarative data, never active content.** A chart artifact is a closed **ChartSpec**
   (kind + series + axes) rendered by our own SVG components; a report is **markdown**; a table is JSON rows;
   an export is a file ref. No HTML/JS artifacts — nothing an LLM emits is ever executed or injected into
   the DOM (XSS). This also keeps the no-chart-library stance: we extend our hand-rolled SVG, not add vega.
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
`apps/web/.../model/analysis.ts` into `@everdict/domain` (pure fns over the light `ScorecardRecord`
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
  `agent-artifacts/<tenant>/<id>` with the **key** stored and the URL **minted at read time** (a new
  `getUrl(key)` on the `ArtifactStore` port — presigned URLs expire, so persisting `put()`'s ref is only
  correct for one-shot links like `analysisRef`).
- **Emission tools** (first-party, in `first-party.ts` style but host-native — no network hop needed):
  `render_chart {spec}` (validated ChartSpec → chart artifact), `write_report {title, markdown}`,
  `export_table {title, rows}`. The agent host (`apps/agent`) persists the record, links it to the
  session/message, and streams an `artifact` SSE event.
- **ChartSpec** (closed, zod-validated, in contracts): `{type: 'line'|'bar'|'area'|'scatter'|'dist',
  title, x, series: [{label, points}], y?: {unit, domain}}` with point caps. Rendered by a new
  `apps/web/src/shared/ui/charts/*` family grown from the existing hand-rolled SVG
  (`scorecard-analyzer.tsx` line chart generalized).
- **View attachment**: `pin_artifact` (host tool + `POST /views/:id/artifacts/:artifactId/pin` + web pin
  button) attaches an artifact to a view; the view page shows the pinned gallery. Unpinned artifacts
  remain browsable in their conversation.

### C. Studio surface (web redesign)

`/views/[id]` becomes the **Analysis Studio**: the pivot canvas (existing `CustomAnalyzer`, live) + an
embedded agent conversation (reusing `features/agent-chat` components — transcript, composer, SSE,
HITL dialogs) + the artifact rail (pinned gallery; click → preview dialog with download). New FSD slices:
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
- **V3 — the Studio.** `/views/[id]` redesign (canvas + embedded chat + artifact rail), session `viewId`,
  view-context preamble, `apply_view_config` host tool + `view_config` SSE + live canvas apply,
  `pin_artifact` + pinned gallery + `/views` card thumbnails. This is the slice that delivers the
  "NL-driven analysis on every view" experience end-to-end.
- **V4 — scheduled reports.** Schedule `report` template kind + fire branch + `AgentReportRunner` +
  headless turn (budgeted, read+emit tools only) + report archive on the view + `notifyReport` fan-out +
  schedules web form gains the report kind (view picker + instructions + cadence) — or equivalently a
  "Report" tab on the view that creates the schedule underneath (recommended UX; one engine either way).
- **V5 — sandboxed `run_analysis`.** The dispatched script tool (D), isolated-runtime-only + HITL;
  starter snippets (cohort split, significance test on pass-rate deltas, custom bucketing). Off by
  default per workspace (an `AgentSpec.disabledDefaults`-style toggle, default disabled).
- **V6 — polish.** Report period-over-period diffs rendered as delta chips; regression callouts wired to
  `diff_scorecards`; artifact search/browse page; comment threads on artifacts (reuse `view` comments or
  extend resource types); MCP parity for any human-facing surface added along the way.

## Non-goals / guardrails

- **No active-content artifacts.** Markdown + ChartSpec + files only; no HTML/JS rendering of
  LLM-emitted content, ever.
- **No control-plane code execution.** `run_analysis` and any code capability dispatch through the
  job-runner isolation path (code-judge invariant); non-isolated runtimes refuse.
- **No new authz surface.** Views/artifacts/reports gate on `scorecards:read`/`scorecards:run`; schedules
  keep `schedules:*`; edit/delete stays creator-or-admin. Artifacts inherit the view's visibility;
  a private view's artifacts 404 to non-owners (no existence leak).
- **No parallel scheduler.** Reports are `ScheduleRecord`s — Temporal reconciliation, overlap policy,
  fire-now, history and provenance all come for free and stay in one place.
- **Bounded autonomy.** Headless report turns: read + emission tools only, hard turn/token budget,
  tenant-attributed cost via the workspace model binding; failures stamp the schedule, never crash it.
