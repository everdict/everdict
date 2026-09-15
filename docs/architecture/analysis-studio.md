---
kind: wiki
title: "Analysis Studio — natural-language analysis, artifacts, and scheduled reports over Views"
status: current
updated: 2026-09-15
anchors: [packages/contracts/src/records/analysis-artifact.ts, apps/agent/src/artifact-tools.ts, apps/agent/src/view-config-tool.ts, apps/agent/src/report-turn.ts, apps/web/src/entities/analysis-artifact/ui/artifact-card.tsx]
---
# Analysis Studio — natural-language analysis, artifacts, and scheduled reports over Views

Scorecard analysis is driven through the workspace agent. The member asks in natural language; the agent draws
the answer on the same pivot engine a saved View uses; what it produces lands as durable **artifacts** on the
conversation that can be pinned to a View; and a **report schedule** runs the same analysis unattended, so the
result reaches the team without anyone asking. The feature composes
[scorecard-analysis-views.md](./scorecard-analysis-views.md) (the pivot engine and saved Views),
[agent-conversations.md](./agent-conversations.md) (the conversational agent runtime) and
[agent-teams.md](./agent-teams.md) (request-less agent turns).

Code comments cite this page by slice label: **V1** server-side query · **V2** artifacts · **V3** the studio
surface (section C) · **V4** scheduled reports · **V5** `run_analysis`.

## Principles

1. **One engine.** The agent can only put on the canvas a config the pivot engine can draw (`AnalysisConfig` →
   `computeAnalysis`), so nothing on the canvas is outside the platform's own vocabulary. Anything beyond the
   pivot is an artifact, never a parallel rendering path on the canvas.
2. **LLM output never executes in the app origin.** The declarative kinds are drawn by our own components; the
   free-form `html` kind runs only in an opaque-origin sandboxed iframe (`sandbox="allow-scripts"`, no
   `allow-same-origin`) under a shell-injected CSP (`default-src 'none'`; inline style/script; `data:`/`blob:`
   images) — no parent DOM, no cookies, no network.
3. **Model-authored code runs only on an isolated runtime**, and every call passes the permission gate (V5).
4. **No new authz surface.** Views gate on `scorecards:read`/`scorecards:run`, schedules on
   `schedules:read`/`schedules:write`; artifacts inherit the View's `private|workspace` visibility, and a private
   View's artifacts 404 to non-owners (no existence leak).
5. **Reports are schedules.** A third `ScheduleRunTemplate` mode reuses the one scheduling engine — cron,
   timezone, overlap, enable, fire-now, history, `origin.scheduleId` provenance — instead of a parallel
   scheduler.
6. **Unattended turns are bounded**: a read-scoped one-shot token, a turn cap, and no canvas tool.

## A. Server-side analysis query (V1)

The pivot engine's server twin is `packages/domain/src/scorecard/analysis.ts` (`computeAnalysis` over the
structural `AnalysisCard` shape, kept in lockstep with the web engine
`apps/web/src/features/analyze-scorecards/model/analysis.ts`). It is exposed as `POST /scorecards/query` ↔ MCP
`query_scorecards`, and `GET /scorecards/:id/analysis` ↔ MCP `get_scorecard_analysis` returns a scorecard's
offloaded per-case analysis bundle (`analysisRef`, migration 0075). Wire response schemas live in
`packages/contracts/src/wire/scorecard/scorecard-analysis.ts`. Both are reads, so neither is HITL-gated. The web
canvas still computes client-side.

## B. Artifacts (V2)

- **Contract** — `packages/contracts/src/records/analysis-artifact.ts`. `AnalysisArtifactRecordSchema` is
  `{id, tenant, kind, title, sessionId, viewId?, pinned, spec, createdBy, createdAt}`; kinds are
  `chart | table | report | html | dashboard`. `spec` is opaque jsonb in storage and validated per kind at the
  emission boundary by `parseAnalysisArtifactSpec`. `ChartSpecSchema` is `{type: line|bar, x, series, yUnit?}`
  (at most 12 series and 500 points); a report is markdown; a dashboard is a list of blocks.
- **Storage** — the `AnalysisArtifactStore` port (application-control) with in-memory and Pg implementations
  (`packages/db/src/activity/analysis-artifact-store.ts`, migration 0077). Every payload is an inline spec; there
  is no blob or file artifact kind.
- **Emission tools** — `apps/agent/src/artifact-tools.ts`: `render_dashboard`, `render_chart`, `render_table`,
  `render_html`, `write_report`. They are host-native and `isReadOnly: true` (they write conversation-scoped
  presentation state), and are registered per turn when the chat host has an artifact store. The host persists
  the record and streams an `artifact` SSE event; the kernel's `ToolResult` carries no artifact field.
- **Routes** (agent service, `apps/agent/src/server.ts`) — `GET /agent/sessions/:id/artifacts` (only for a
  conversation visible to the caller, oldest first); `GET /agent/views/:viewId/artifacts` (the View's visibility re-checked against the control plane
  with the caller's bearer, `viewAccessChecker`); `POST`/`DELETE /agent/artifacts/:id/pin` (creator-only, target
  View re-checked); `GET /agent/views/artifacts-summary?ids=` (count and newest report time, answered only for the
  ids the caller already holds).

### The structured dashboard is the default; `html` is the escape hatch

A dashboard is `metrics` · `chart` · `table` · `note` blocks, each drawn by the renderer its kind already has, so it
is a layout over the primitives and has no way to express a color, size or font. The agent sends a metric's
`baseline`, never a delta — we subtract, round and format — and `higherIsBetter` decides the chip's color, so a
rising cost reads as a regression. Extending the dashboard means adding a block kind, never letting a block carry
styling.

An `html` artifact authors structure and numbers; the frame authors the look. The sandbox inherits no stylesheet
or theme, so `ArtifactCard` reads the live values of `ARTIFACT_FRAME_TOKENS` off the running theme, bakes them into
`srcDoc` (re-baked on theme toggle), and ships the `ARTIFACT_FRAME_CLASSES` vocabulary (`.metric`,
`.delta up|down|flat`, `.panel`, `.grid`, …). `HtmlSpecSchema` rejects markup that paints outside it — hex/rgb/hsl
literals, named colors, gradients, `font-family`, emoji — as a correctable tool error. The color rules read only
styling regions (`<style>`, `style=""`, paint attributes), never content, so data such as "case #4521" is not
bounced as design. The frame measures its content and reports the height up.

## C. The studio surface (V3)

- **Layout** — the left pane is the routed canvas and the right pane is the one persistent agent conversation
  (the `widgets/infra-panel` agent tab); no page embeds its own chat.
- **The canvas is conversation-only.** `/{ws}/scorecards/analyze` (`CustomAnalyzer`) has no pickers, presets,
  stat tiles, search or filter bar. A new analysis lands blank with the chat opened on a fresh conversation
  (`AgentChatOpener`; "New analysis" on `/{ws}/views` links to `?chat=1`); a `?view=<id>` or config deep link
  fills it on arrival. What remains on the canvas: `describeConfig` chips, one save control (create a View or
  update the open one), the chart or table, and a raw-rows drill-down under a clicked mark.
- **Agent → canvas** — `apply_view_config` (`apps/agent/src/view-config-tool.ts`) takes the saved-View
  stored-form config. It is registered only when the live web chat wires `ChatHooks.onViewConfig`, so headless
  turns never carry it. The host emits a `view_config` SSE event, the chat panel re-broadcasts it as the
  same-window `everdict:view-config` event, and `CustomAnalyzer` applies it via `storedToConfig`.
- **Canvas → agent** — the canvas answers `everdict:canvas-state-request` with `everdict:canvas-state`
  (`configToStored(config)` plus the open View id), announces itself on mount and change, and clears on
  unmount. The composer shows a "canvas linked" chip, each send carries `canvas {config, viewId?}`, and
  `buildCanvasPreamble` (`apps/agent/src/chat.ts`) folds it into the turn with the delta-editing rule and the
  save path (`update_view` for an open View, `create_view` otherwise). An empty canvas is announced as empty.
- **Artifacts in the UI** — `ArtifactCard` (`apps/web/src/entities/analysis-artifact/ui/artifact-card.tsx`)
  renders every kind; charts use the `apps/web/src/shared/ui/charts` family and plot at most `MAX_SERIES`,
  disclosing the rest. The transcript interleaves artifacts by creation time (`buildTranscript` in
  `apps/web/src/features/agent-chat/lib/transcript.ts`), hydrated on session open and appended live from SSE.
  `PinControl` (`features/analysis-artifacts`) rides the card's action slot.
- **The View page** — `/{ws}/view/{id}` (`apps/web/src/app/[workspace]/view/[id]/page.tsx`) renders the canvas,
  the View's snapshots, its report schedules (`features/view-report-schedule`: run-now/pause/delete rows and a
  create dialog with weekly/daily/monthly/custom cadence, standing instructions and a previous-period toggle),
  the pinned-artifact gallery (`ViewArtifactGallery`, a server component over `agentPlane.listViewArtifacts`) and
  comments. Cards on `/{ws}/views` carry the artifact count and last report time.

Agent sessions carry no `viewId`; mentioning a View (`@view`) is how a conversation is given its context.

## D. Sandboxed analysis scripts (V5)

`run_analysis {language: python|node, code, input?}` (`apps/agent/src/analysis-script-tool.ts`) runs the model's
script through the code-tool contract (`buildCodeTool`: provision → input file → interpreter → stdout) with an
empty `env` and a 60-second timeout. `isReadOnly: false` puts every call behind the permission gate, and the
builder returns no tool at all on a non-isolated runtime. It is wired through `ChatDeps.analysisScriptRuntime`
only when the operator sets `AGENT_ALLOW_RUN_ANALYSIS=true` — but the agent service's own code runtime is a
non-isolated `LocalDriver` (`apps/agent/src/main.ts`), so as shipped the flag registers nothing.

## E. Scheduled reports (V4)

- **Template** — `packages/contracts/src/records/schedule.ts`: `runTemplate.report = {view, instructions?,
  compare?: "previous-period"}`, exactly one of batch / pull / report. MCP `create_schedule` takes `report_view`.
- **Fire** — `ScheduleService.fire` emits `schedule.fired`, captures a View snapshot (best-effort), then calls the
  `AgentReportRunner` port. The control-plane adapter (`apps/api/src/composition/schedule.ts`) posts to the agent
  service's `POST /internal/report` with `x-internal-token`; it is wired only when `AGENT_SERVICE_URL` and
  `AGENT_INTERNAL_TOKEN` are set on the control plane (the agent service needs `AGENT_INTERNAL_TOKEN` too), and
  without it a report fire answers 400. The schedule is stamped `lastStatus: reported | report-empty` and
  `lastArtifactId` (migration 0078); a config-class failure auto-disables the schedule and the error is
  rethrown. `scheduledScorecardWorkflow` returns without polling when a fire yields no scorecard.
- **Turn** — `runReportTurn` (`apps/agent/src/report-turn.ts`) mints a read-scoped `agt_` token acting as the
  schedule creator (revoked in a `finally`), records the turn as a run, and runs one headless chat turn capped
  at 24 model turns with persistent retry. The prompt walks `get_view` → `query_scorecards` (at most six queries,
  plus the shifted previous window when `compare` is set) → `render_dashboard` → a brief `write_report`. Every
  artifact the session produced is attached to the View; the primary is the newest dashboard, else html, else
  report.
- **Delivery** — the adapter calls `NotificationService.notifyReport`: a `report_completed` feed row for the
  creator linking `{resourceType: view, artifactId}`, and a trigger-matchable `report.completed` platform event.
  The Mattermost post rides that event through the `mm:completions` consumer
  ([event-plumbing.md](./event-plumbing.md)). A notification failure never fails the report.
